# app.py - Corrected audio channel assignment
import os
import json
import logging
from io import BytesIO

import numpy as np
from flask import Flask, jsonify, render_template, request, Response
from flask_sqlalchemy import SQLAlchemy
from scipy.io.wavfile import write
from dotenv import load_dotenv

# --- Configuration ---
load_dotenv()
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)


# --- App & Database Initialization ---
app = Flask(__name__)
# Use DATABASE_URL if available, otherwise fallback to SQLite
db_url = os.environ.get('DATABASE_URL')

# Fix: Handle empty strings or whitespace-only strings, or missing protocol
if not db_url or not db_url.strip() or '://' not in db_url:
    logger.warning(f"DATABASE_URL is invalid or not set: '{db_url}'. Falling back to SQLite.")
    db_url = 'sqlite:///users.db'

# Fix: SQLAlchemy 1.4+ requires postgresql://, not postgres://
if db_url and db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

print(f"DEBUG: Final db_url being used: {db_url}")

app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)


# --- Supabase Client Initialization (optional) ---
supabase = None
try:
    url: str = os.environ.get("SUPABASE_URL")
    key: str = os.environ.get("SUPABASE_KEY")
    if url and key:
        from supabase import create_client
        supabase = create_client(url, key)
        logger.info("Supabase client initialized")
    else:
        logger.info("SUPABASE_URL or SUPABASE_KEY not set; Supabase client disabled")
except Exception as e:
    logger.warning(f"Supabase initialization failed (non-fatal): {e}")


# --- Database Model Definition ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100))
    surname = db.Column(db.String(100))
    age_group = db.Column(db.String(50))
    gender = db.Column(db.String(50))
    # Link to Supabase Auth User ID (UUID string)
    supabase_id = db.Column(db.String(36), unique=True, nullable=True) 
    left_avg = db.Column(db.Float, nullable=True)
    right_avg = db.Column(db.Float, nullable=True)
    dissimilarity = db.Column(db.Float, nullable=True)
    test_state = db.Column(db.Text, nullable=True)

def run_migrations():
    """Simple SQLite migration for dev/demo."""
    with app.app_context():
        inspector = db.inspect(db.engine)
        columns = [c['name'] for c in inspector.get_columns('user')]
        if 'supabase_id' not in columns:
            logger.info("Migrating: Adding supabase_id column to User table")
            with db.engine.connect() as conn:
                conn.execute(db.text("ALTER TABLE user ADD COLUMN supabase_id TEXT UNIQUE"))
                conn.commit()

# Run migration on import/start
try:
    if 'sqlite' in app.config['SQLALCHEMY_DATABASE_URI']:
        run_migrations()
except Exception as e:
    logger.warning(f"Migration failed (might be already done or not sqlite): {e}")


# --- Core Application Routes ---
@app.route('/')
def index():
    return render_template('index.html', 
                           supabase_url=os.environ.get("SUPABASE_URL"), 
                           supabase_key=os.environ.get("SUPABASE_KEY"))


@app.route('/register', methods=['POST'])
def register():
    data = request.json or {}
    supabase_id = data.get('supabase_id')
    
    # If supabase_id is provided, check if user exists
    if supabase_id:
        existing_user = User.query.filter_by(supabase_id=supabase_id).first()
        if existing_user:
            # Update info if needed, or just return existing ID
            existing_user.name = data.get('name', existing_user.name)
            existing_user.surname = data.get('surname', existing_user.surname)
            db.session.commit()
            logger.debug(f"User found via Supabase ID: local_ID={existing_user.id}")
            return jsonify({
                'user_id': existing_user.id, 
                'is_new': False,
                'name': existing_user.name,
                'surname': existing_user.surname,
                'age_group': existing_user.age_group,
                'gender': existing_user.gender
            })

    try:
        new_user = User(
            name=data.get('name'),
            surname=data.get('surname'),
            age_group=data.get('age_group'),
            gender=data.get('gender'),
            supabase_id=supabase_id,
            test_state=json.dumps({})
        )
        db.session.add(new_user)
        db.session.commit()
        logger.debug(f"User registered: ID={new_user.id}, SupabaseID={supabase_id}")
        return jsonify({
            'user_id': new_user.id, 
            'is_new': True,
            'name': new_user.name,
            'surname': new_user.surname
        })
    except Exception as e:
        db.session.rollback()
        logger.error(f"Registration error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/start_test', methods=['POST'])
def start_test():
    data = request.json or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400

    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    test_frequencies = [5000, 4000, 2000, 1000, 500, 250]
    test_sequence = [{'freq': freq, 'ear': ear} for freq in test_frequencies for ear in ['right', 'left']]

    test_state = {
        'thresholds': {'left': {}, 'right': {}},
        'test_sequence': test_sequence,
        'current_test_index': 0,
        'total_tests': len(test_sequence),
        'current_test': {
            'frequency': test_sequence[0]['freq'],
            'ear': test_sequence[0]['ear'],
            'current_level': 40,
            'responses': [],
            'trial_count': 0,
            'max_trials': 12
        }
    }
    
    try:
        user.test_state = json.dumps(test_state)
        db.session.commit()
        logger.debug(f"Test started for user ID={user_id}")
        return jsonify({
            'freq': test_state['current_test']['frequency'],
            'ear': test_state['current_test']['ear'],
            'level': test_state['current_test']['current_level'],
            'progress': 0,
            'test_number': 1,
            'total_tests': test_state['total_tests']
        })
    except Exception as e:
        db.session.rollback()
        logger.error(f"Start test error for user {user_id}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/submit_response', methods=['POST'])
def submit_response():
    data = request.json or {}
    user_id = data.get('user_id')
    heard = data.get('heard')
    if not user_id or heard is None:
        return jsonify({'error': 'User ID and response required'}), 400

    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    try:
        test_state = json.loads(user.test_state or '{}')
        current_test = test_state.get('current_test')
        if not current_test:
            return jsonify({'error': 'Invalid test state: no current test'}), 500

        current_test['responses'] = current_test.get('responses', [])
        current_test['trial_count'] = current_test.get('trial_count', 0) + 1
        old_level = current_test.get('current_level', 40)
        current_test['responses'].append({'level': old_level, 'heard': heard})

        if heard:
            current_test['current_level'] = int(max(-10, old_level - 10))
        else:
            current_test['current_level'] = int(min(40, old_level + 5))

        should_compute_threshold = (
            (heard and current_test['current_level'] == old_level) or
            current_test['trial_count'] >= current_test.get('max_trials', 12)
        )

        if should_compute_threshold:
            threshold = compute_threshold(current_test['responses'])
            freq = int(current_test['frequency'])
            test_state['thresholds'][current_test['ear']][freq] = float(threshold)
            test_state['current_test_index'] += 1

            if test_state['current_test_index'] < test_state['total_tests']:
                next_test_data = test_state['test_sequence'][test_state['current_test_index']]
                test_state['current_test'] = {
                    'frequency': next_test_data['freq'], 'ear': next_test_data['ear'],
                    'current_level': 40, 'responses': [], 'trial_count': 0, 'max_trials': 12
                }
        
        user.test_state = json.dumps(test_state)
        db.session.commit()
        return jsonify({'success': True})

    except Exception as e:
        db.session.rollback()
        logger.error(f"Submit response error for user {user_id}: {e}")
        return jsonify({'error': f'Internal server error: {str(e)}'}), 500


@app.route('/next_test', methods=['GET'])
def next_test():
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400

    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    try:
        test_state = json.loads(user.test_state or '{}')
        current_test_index = test_state.get('current_test_index', 0)
        total_tests = test_state.get('total_tests', 0)

        if current_test_index >= total_tests:
            test_frequencies = [5000, 4000, 2000, 1000, 500, 250]
            for ear in ['left', 'right']:
                for freq in test_frequencies:
                    if str(freq) not in test_state['thresholds'][ear]:
                        test_state['thresholds'][ear][str(freq)] = 40.0
            
            left_values = [test_state['thresholds']['left'][str(f)] for f in test_frequencies]
            right_values = [test_state['thresholds']['right'][str(f)] for f in test_frequencies]
            
            is_valid = not all(val == 40.0 for val in left_values + right_values)
            left_avg = sum(left_values) / len(left_values)
            right_avg = sum(right_values) / len(right_values)
            max_diff = max(abs(l - r) for l, r in zip(left_values, right_values))

            user.left_avg = left_avg
            user.right_avg = right_avg
            user.dissimilarity = max_diff
            db.session.commit()

            return jsonify({
                'completed': True, 'is_valid': is_valid,
                'thresholds': test_state['thresholds'],
                'left_avg': left_avg, 'right_avg': right_avg, 'max_diff': max_diff
            })
        else:
            current_test = test_state.get('current_test', {})
            progress = (current_test_index / total_tests) * 100 if total_tests > 0 else 0
            return jsonify({
                'completed': False,
                'freq': current_test.get('frequency'), 'ear': current_test.get('ear'),
                'level': current_test.get('current_level'), 'progress': progress,
                'test_number': current_test_index + 1, 'total_tests': total_tests
            })
    except Exception as e:
        logger.error(f"Next test error for user {user_id}: {e}")
        return jsonify({'error': str(e)}), 500


# --- Helper Functions ---

@app.route('/tone')
def generate_tone():
    try:
        freq = int(request.args.get('freq', 1000))
        duration = float(request.args.get('duration', 0.35))
        volume = float(request.args.get('volume', 1.0))
        channel = request.args.get('channel', 'both')

        if freq < 20 or freq > 20000:
            return ("Frequency out of audible range (20-20000 Hz)", 400)

        sample_rate = 44100
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        note = np.sin(2 * np.pi * freq * t) * volume

        fade_samples = int(sample_rate * 0.01)
        fade_in = np.linspace(0, 1, fade_samples)
        fade_out = np.linspace(1, 0, fade_samples)
        note[:fade_samples] *= fade_in
        note[-fade_samples:] *= fade_out

        left_arr = np.zeros_like(note)
        right_arr = np.zeros_like(note)

        if channel == 'both':
            left_arr, right_arr = note, note
        elif channel == 'left':
            left_arr = note
        else:  # 'right'
            right_arr = note

        # Standard channel assignment: left channel first, right channel second
        audio = np.column_stack((left_arr, right_arr))

        audio_int16 = (audio * 32767 * 0.8).astype(np.int16)

        bio = BytesIO()
        write(bio, sample_rate, audio_int16)
        bio.seek(0)
        return Response(bio.getvalue(), mimetype='audio/wav')
    except Exception as e:
        logger.error(f"Error generating tone: {e}")
        return ("Error generating tone", 500)


def compute_threshold(responses):
    if not responses:
        return 40.0
    level_map = {}
    for r in responses:
        level = r.get('level')
        if level is None: continue
        try: level = float(level)
        except (TypeError, ValueError): continue
        if level not in level_map: level_map[level] = {'yes': 0, 'total': 0}
        level_map[level]['total'] += 1
        if r.get('heard'): level_map[level]['yes'] += 1
    levels = sorted(level_map.keys())
    candidate_levels = [l for l in levels if (level_map[l]['yes'] / level_map[l]['total']) >= 0.5]
    if candidate_levels: return min(candidate_levels)
    heard_levels = [l for l in levels if level_map[l]['yes'] > 0]
    return min(heard_levels) if heard_levels else 40.0


# --- Custom CLI Command ---
@app.cli.command("create-db")
def create_db():
    """Creates the database tables."""
    with app.app_context():
        db.create_all()
    print("Database tables created successfully.")


if __name__ == '__main__':
    import os
    debug_mode = os.environ.get('FLASK_ENV') == 'development'
    port = int(os.environ.get('PORT', 5000))
    app.run(debug=debug_mode, host='0.0.0.0', port=port)

