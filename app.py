# app.py - Corrected audio channel assignment
import os
import json
import logging
import uuid
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
db_url = os.environ.get('DATABASE_URL', '').strip()

# Fix: Handle invalid database URLs
if not db_url or '://' not in db_url or db_url.startswith('psql '):
    logger.warning(f"DATABASE_URL is invalid or not set: '{db_url}'. Falling back to SQLite.")
    db_url = 'sqlite:///users.db'
else:
    # Fix: SQLAlchemy 1.4+ requires postgresql://, not postgres://
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://", 1)

logger.info(f"Using database URL: {db_url[:20]}...")

app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

try:
    db = SQLAlchemy(app)
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")
    raise


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
    # Authentication type: 'authenticated' or 'guest'
    auth_type = db.Column(db.String(20), default='guest', nullable=False)
    # Timestamps for tracking
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    updated_at = db.Column(db.DateTime, default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())
    left_avg = db.Column(db.Float, nullable=True)
    right_avg = db.Column(db.Float, nullable=True)
    dissimilarity = db.Column(db.Float, nullable=True)
    test_state = db.Column(db.Text, nullable=True)
    
    def to_dict(self):
        """Convert user to dictionary for JSON responses"""
        return {
            'id': self.id,
            'name': self.name,
            'surname': self.surname,
            'age_group': self.age_group,
            'gender': self.gender,
            'auth_type': self.auth_type,
            'supabase_id': self.supabase_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }


class ScreeningSessions(db.Model):
    """
    Stores individual screening test results for authenticated users only.
    Each row represents one frequency test result.
    Guest sessions are never persisted to maintain privacy.
    
    Table structure matches exact specification:
    - session_id (UUID): Groups related test results
    - user_id (nullable): Links to authenticated user
    - timestamp: When the test was performed
    - ear: 'left' or 'right'
    - frequency_hz: Test frequency (250, 500, 1000, 2000, 4000, 5000)
    - threshold_db: Measured threshold in dB HL
    """
    __tablename__ = 'screening_sessions'
    
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), nullable=False, index=True)  # UUID - not unique to allow multiple rows per session
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)  # Nullable as specified
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp(), nullable=False)
    ear = db.Column(db.String(5), nullable=False)  # 'left' or 'right'
    frequency_hz = db.Column(db.Integer, nullable=False)  # Test frequency
    threshold_db = db.Column(db.Float, nullable=False)  # Threshold in dB HL
    
    # Relationship to user
    user = db.relationship('User', backref=db.backref('screening_sessions', lazy=True))
    
    # Composite index for efficient queries
    __table_args__ = (
        db.Index('idx_session_user', 'session_id', 'user_id'),
        db.Index('idx_user_timestamp', 'user_id', 'timestamp'),
    )
    
    def to_dict(self):
        """Convert screening result to dictionary for JSON responses"""
        return {
            'id': self.id,
            'session_id': self.session_id,
            'user_id': self.user_id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'ear': self.ear,
            'frequency_hz': self.frequency_hz,
            'threshold_db': self.threshold_db
        }
    
    @classmethod
    def get_sessions_for_user(cls, user_id, limit=50, offset=0):
        """Get all sessions for a user, grouped by session_id"""
        return db.session.query(cls).filter_by(user_id=user_id)\
            .order_by(cls.timestamp.desc())\
            .offset(offset).limit(limit).all()
    
    @classmethod
    def get_session_summary(cls, session_id):
        """Get summary statistics for a specific session"""
        results = cls.query.filter_by(session_id=session_id).all()
        
        if not results:
            return None
        
        # Group by ear
        left_thresholds = [r.threshold_db for r in results if r.ear == 'left']
        right_thresholds = [r.threshold_db for r in results if r.ear == 'right']
        
        summary = {
            'session_id': session_id,
            'timestamp': results[0].timestamp,
            'user_id': results[0].user_id,
            'left_avg': sum(left_thresholds) / len(left_thresholds) if left_thresholds else None,
            'right_avg': sum(right_thresholds) / len(right_thresholds) if right_thresholds else None,
            'frequency_count': len(results),
            'ears_tested': len(set(r.ear for r in results))
        }
        
        # Calculate dissimilarity if both ears tested
        if summary['left_avg'] is not None and summary['right_avg'] is not None:
            # Find max difference across frequencies
            freq_diffs = []
            frequencies = set(r.frequency_hz for r in results)
            
            for freq in frequencies:
                left_val = next((r.threshold_db for r in results if r.ear == 'left' and r.frequency_hz == freq), None)
                right_val = next((r.threshold_db for r in results if r.ear == 'right' and r.frequency_hz == freq), None)
                
                if left_val is not None and right_val is not None:
                    freq_diffs.append(abs(left_val - right_val))
            
            summary['dissimilarity'] = max(freq_diffs) if freq_diffs else None
        else:
            summary['dissimilarity'] = None
        
        return summary

def run_migrations():
    """Database migration for both SQLite and PostgreSQL."""
    with app.app_context():
        try:
            inspector = db.inspect(db.engine)
            
            # Check if user table exists, if not create all tables
            if not inspector.has_table('user'):
                logger.info("Creating all database tables")
                db.create_all()
                return
            
            columns = [c['name'] for c in inspector.get_columns('user')]
            is_postgres = 'postgresql' in str(db.engine.url)
            
            # Add supabase_id column if missing
            if 'supabase_id' not in columns:
                logger.info("Migrating: Adding supabase_id column to User table")
                with db.engine.connect() as conn:
                    if is_postgres:
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN supabase_id VARCHAR(36) UNIQUE'))
                    else:
                        conn.execute(db.text("ALTER TABLE user ADD COLUMN supabase_id TEXT UNIQUE"))
                    conn.commit()
            
            # Add auth_type column if missing
            if 'auth_type' not in columns:
                logger.info("Migrating: Adding auth_type column to User table")
                with db.engine.connect() as conn:
                    if is_postgres:
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN auth_type VARCHAR(20) DEFAULT \'guest\''))
                    else:
                        conn.execute(db.text("ALTER TABLE user ADD COLUMN auth_type TEXT DEFAULT 'guest'"))
                    conn.commit()
            
            # Add timestamp columns if missing
            if 'created_at' not in columns:
                logger.info("Migrating: Adding timestamp columns to User table")
                with db.engine.connect() as conn:
                    if is_postgres:
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'))
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'))
                    else:
                        conn.execute(db.text("ALTER TABLE user ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"))
                        conn.execute(db.text("ALTER TABLE user ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"))
                    conn.commit()
                    
            # Create new screening_sessions table if it doesn't exist
            if not inspector.has_table('screening_sessions'):
                logger.info("Creating screening_sessions table")
                ScreeningSessions.__table__.create(db.engine)
                
            logger.info("Database migration completed successfully")
            
        except Exception as e:
            logger.error(f"Migration error: {e}")
            # If migration fails, try to create all tables
            try:
                logger.info("Migration failed, attempting to create all tables")
                db.create_all()
            except Exception as create_error:
                logger.error(f"Table creation also failed: {create_error}")
                raise

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
    
    # Determine authentication type
    auth_type = 'authenticated' if supabase_id else 'guest'
    
    # If supabase_id is provided, check if user exists
    if supabase_id:
        existing_user = User.query.filter_by(supabase_id=supabase_id).first()
        if existing_user:
            # Update info if needed, or just return existing ID
            existing_user.name = data.get('name', existing_user.name)
            existing_user.surname = data.get('surname', existing_user.surname)
            existing_user.age_group = data.get('age_group', existing_user.age_group)
            existing_user.gender = data.get('gender', existing_user.gender)
            existing_user.auth_type = 'authenticated'
            db.session.commit()
            logger.debug(f"User found via Supabase ID: local_ID={existing_user.id}")
            return jsonify({
                'user_id': existing_user.id, 
                'is_new': False,
                'auth_type': existing_user.auth_type,
                'user_data': existing_user.to_dict()
            })

    try:
        new_user = User(
            name=data.get('name'),
            surname=data.get('surname'),
            age_group=data.get('age_group'),
            gender=data.get('gender'),
            supabase_id=supabase_id,
            auth_type=auth_type,
            test_state=json.dumps({})
        )
        db.session.add(new_user)
        db.session.commit()
        logger.debug(f"User registered: ID={new_user.id}, Type={auth_type}, SupabaseID={supabase_id}")
        return jsonify({
            'user_id': new_user.id, 
            'is_new': True,
            'auth_type': auth_type,
            'user_data': new_user.to_dict()
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


@app.route('/auth/status', methods=['GET'])
def auth_status():
    """Check authentication status and return user info if authenticated"""
    user_id = request.args.get('user_id')
    supabase_id = request.args.get('supabase_id')
    
    if not user_id and not supabase_id:
        return jsonify({'authenticated': False, 'user': None})
    
    try:
        user = None
        if supabase_id:
            user = User.query.filter_by(supabase_id=supabase_id).first()
        elif user_id:
            user = User.query.get(user_id)
        
        if user:
            return jsonify({
                'authenticated': user.auth_type == 'authenticated',
                'user': user.to_dict()
            })
        else:
            return jsonify({'authenticated': False, 'user': None})
    except Exception as e:
        logger.error(f"Auth status error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/user/profile', methods=['GET'])
def get_user_profile():
    """Get user profile information"""
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        return jsonify({
            'user': user.to_dict(),
            'has_test_history': bool(user.left_avg or user.right_avg)
        })
    except Exception as e:
        logger.error(f"Profile error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/user/profile', methods=['PUT'])
def update_user_profile():
    """Update user profile information"""
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    data = request.json or {}
    
    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        # Only allow updates for authenticated users
        if user.auth_type != 'authenticated':
            return jsonify({'error': 'Profile updates only available for authenticated users'}), 403
        
        # Update allowed fields
        if 'name' in data:
            user.name = data['name']
        if 'surname' in data:
            user.surname = data['surname']
        if 'age_group' in data:
            user.age_group = data['age_group']
        if 'gender' in data:
            user.gender = data['gender']
        
        db.session.commit()
        logger.debug(f"Profile updated for user ID={user_id}")
        
        return jsonify({
            'success': True,
            'user': user.to_dict()
        })
    except Exception as e:
        db.session.rollback()
        logger.error(f"Profile update error: {e}")
        return jsonify({'error': str(e)}), 500


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

            # Save screening session for authenticated users only
            session_id = save_screening_session(
                user_id=user.id,
                thresholds=test_state['thresholds'],
                left_avg=left_avg,
                right_avg=right_avg,
                dissimilarity=max_diff
            )

            return jsonify({
                'completed': True, 'is_valid': is_valid,
                'thresholds': test_state['thresholds'],
                'left_avg': left_avg, 'right_avg': right_avg, 'max_diff': max_diff,
                'session_id': session_id  # Will be None for guest users
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


@app.route('/user/test-history', methods=['GET'])
def get_test_history():
    """
    Get comprehensive test history for authenticated users from screening_sessions table.
    
    Query Parameters:
    - user_id (required): User ID to fetch history for
    - limit (optional): Maximum number of sessions to return (default: 50)
    - offset (optional): Number of sessions to skip for pagination (default: 0)
    
    Returns:
    - Grouped results by session_id
    - Sessions ordered by timestamp (latest first)
    - Detailed frequency-specific thresholds
    - Summary statistics per session
    """
    user_id = request.args.get('user_id')
    limit = min(int(request.args.get('limit', 50)), 100)  # Cap at 100 sessions
    offset = int(request.args.get('offset', 0))
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        # Verify user exists and has proper access
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        # Strict access control: only authenticated users can access history
        if user.auth_type != 'authenticated':
            logger.warning(f"Unauthorized test history access attempt by user {user_id} (type: {user.auth_type})")
            return jsonify({
                'error': 'Test history only available for authenticated users',
                'auth_required': True
            }), 403
        
        # Get all screening session rows for this user
        all_results = ScreeningSessions.query.filter_by(user_id=user.id)\
            .order_by(ScreeningSessions.timestamp.desc()).all()
        
        if not all_results:
            return jsonify({
                'user_id': user.id,
                'user_type': user.auth_type,
                'statistics': {
                    'total_sessions': 0,
                    'returned_sessions': 0,
                    'recent_sessions_30d': 0,
                    'has_more': False,
                    'pagination': {'limit': limit, 'offset': offset, 'next_offset': None}
                },
                'history': []
            })
        
        # Group results by session_id
        sessions_dict = {}
        for result in all_results:
            session_id = result.session_id
            if session_id not in sessions_dict:
                sessions_dict[session_id] = {
                    'session_id': session_id,
                    'timestamp': result.timestamp,
                    'results': []
                }
            sessions_dict[session_id]['results'].append(result)
        
        # Convert to list and sort by timestamp (latest first)
        sessions_list = list(sessions_dict.values())
        sessions_list.sort(key=lambda x: x['timestamp'], reverse=True)
        
        # Apply pagination
        total_sessions = len(sessions_list)
        paginated_sessions = sessions_list[offset:offset + limit]
        
        history = []
        for session_data in paginated_sessions:
            session_id = session_data['session_id']
            timestamp = session_data['timestamp']
            results = session_data['results']
            
            # Organize results by ear and frequency
            thresholds = {'left': {}, 'right': {}}
            for result in results:
                thresholds[result.ear][result.frequency_hz] = result.threshold_db
            
            # Calculate summary statistics using the class method
            summary = ScreeningSessions.get_session_summary(session_id)
            
            # Calculate session completeness
            expected_frequencies = [250, 500, 1000, 2000, 4000, 5000]
            completeness = {
                'left': len([f for f in expected_frequencies if f in thresholds['left']]),
                'right': len([f for f in expected_frequencies if f in thresholds['right']]),
                'total_expected': len(expected_frequencies) * 2,
                'total_recorded': len(results)
            }
            
            # Determine session quality
            is_complete = completeness['total_recorded'] >= completeness['total_expected']
            is_valid = summary and summary['left_avg'] is not None and summary['right_avg'] is not None
            
            session_entry = {
                'session_id': session_id,
                'timestamp': timestamp.isoformat(),
                'date': timestamp.strftime('%Y-%m-%d'),
                'time': timestamp.strftime('%H:%M:%S'),
                'summary': {
                    'left_avg': summary['left_avg'] if summary else None,
                    'right_avg': summary['right_avg'] if summary else None,
                    'dissimilarity': summary['dissimilarity'] if summary else None,
                    'asymmetry_detected': (summary['dissimilarity'] >= 20) if (summary and summary['dissimilarity']) else False
                },
                'thresholds': thresholds,
                'metadata': {
                    'test_type': 'screening',
                    'is_complete': is_complete,
                    'is_valid': is_valid,
                    'completeness': completeness,
                    'frequency_count': len(results)
                }
            }
            
            history.append(session_entry)
        
        # Calculate summary statistics
        from datetime import datetime, timedelta
        thirty_days_ago = datetime.now() - timedelta(days=30)
        recent_sessions = [s for s in sessions_list if s['timestamp'] >= thirty_days_ago]
        
        summary_stats = {
            'total_sessions': total_sessions,
            'returned_sessions': len(history),
            'recent_sessions_30d': len(recent_sessions),
            'has_more': (offset + len(history)) < total_sessions,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'next_offset': offset + limit if (offset + len(history)) < total_sessions else None
            }
        }
        
        logger.info(f"Retrieved {len(history)} test sessions for authenticated user {user_id}")
        
        return jsonify({
            'user_id': user.id,
            'user_type': user.auth_type,
            'statistics': summary_stats,
            'history': history
        })
        
    except ValueError as e:
        logger.error(f"Invalid parameter in test history request: {e}")
        return jsonify({'error': 'Invalid request parameters'}), 400
    except Exception as e:
        logger.error(f"Test history error for user {user_id}: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/user/session/<session_id>', methods=['GET'])
def get_session_details(session_id):
    """
    Get detailed information for a specific screening session.
    
    Path Parameters:
    - session_id: UUID of the screening session
    
    Query Parameters:
    - user_id (required): User ID for access control
    
    Returns:
    - Complete session data with all frequency results
    - Session metadata and quality indicators
    """
    user_id = request.args.get('user_id')
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        # Verify user authentication and ownership
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        if user.auth_type != 'authenticated':
            return jsonify({'error': 'Session details only available for authenticated users'}), 403
        
        # Find all results for this session and verify ownership
        results = ScreeningSessions.query.filter_by(
            session_id=session_id, 
            user_id=user.id
        ).all()
        
        if not results:
            return jsonify({'error': 'Session not found or access denied'}), 404
        
        # Get session summary
        summary = ScreeningSessions.get_session_summary(session_id)
        
        # Organize detailed results
        detailed_results = []
        thresholds = {'left': {}, 'right': {}}
        
        for result in results:
            detailed_results.append(result.to_dict())
            thresholds[result.ear][result.frequency_hz] = result.threshold_db
        
        session_data = {
            'session': {
                'session_id': session_id,
                'timestamp': results[0].timestamp.isoformat(),
                'user_id': user.id,
                'summary': summary
            },
            'thresholds': thresholds,
            'detailed_results': detailed_results,
            'analysis': {
                'frequencies_tested': len(set(r.frequency_hz for r in results)),
                'ears_tested': len(set(r.ear for r in results)),
                'asymmetry_detected': (summary['dissimilarity'] >= 20) if (summary and summary['dissimilarity']) else False,
                'significant_frequencies': []
            }
        }
        
        # Identify frequencies with significant asymmetry (>15 dB difference)
        frequencies = set(r.frequency_hz for r in results)
        for freq in frequencies:
            left_val = thresholds['left'].get(freq)
            right_val = thresholds['right'].get(freq)
            
            if left_val is not None and right_val is not None:
                diff = abs(left_val - right_val)
                if diff >= 15:
                    session_data['analysis']['significant_frequencies'].append({
                        'frequency_hz': freq,
                        'left_threshold': left_val,
                        'right_threshold': right_val,
                        'difference': diff
                    })
        
        return jsonify(session_data)
        
    except Exception as e:
        logger.error(f"Session details error for session {session_id}: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/user/sessions/compare', methods=['POST'])
def compare_sessions():
    """
    Compare multiple screening sessions for trend analysis.
    
    Request Body:
    - user_id (required): User ID for access control
    - session_ids (required): Array of session IDs to compare (max 5)
    
    Returns:
    - Comparative analysis of sessions
    - Trend indicators and changes over time
    """
    data = request.json or {}
    user_id = data.get('user_id')
    session_ids = data.get('session_ids', [])
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    if not session_ids or len(session_ids) > 5:
        return jsonify({'error': 'Provide 1-5 session IDs for comparison'}), 400
    
    try:
        # Verify user authentication
        user = User.query.get(user_id)
        if not user or user.auth_type != 'authenticated':
            return jsonify({'error': 'Session comparison only available for authenticated users'}), 403
        
        # Fetch session summaries for comparison
        session_summaries = []
        for session_id in session_ids:
            # Verify ownership by checking if any results exist for this user/session
            results = ScreeningSessions.query.filter_by(
                session_id=session_id,
                user_id=user.id
            ).first()
            
            if not results:
                return jsonify({'error': f'Session {session_id} not found or access denied'}), 404
            
            summary = ScreeningSessions.get_session_summary(session_id)
            if summary:
                session_summaries.append(summary)
        
        if len(session_summaries) != len(session_ids):
            return jsonify({'error': 'One or more sessions could not be processed'}), 404
        
        # Sort by timestamp
        session_summaries.sort(key=lambda x: x['timestamp'])
        
        # Build comparison data
        comparison = {
            'user_id': user.id,
            'sessions': [],
            'trends': {
                'left_avg_trend': [],
                'right_avg_trend': [],
                'dissimilarity_trend': [],
                'time_span_days': 0
            }
        }
        
        for summary in session_summaries:
            comparison['sessions'].append({
                'session_id': summary['session_id'],
                'timestamp': summary['timestamp'].isoformat(),
                'left_avg': summary['left_avg'],
                'right_avg': summary['right_avg'],
                'dissimilarity': summary['dissimilarity']
            })
            
            comparison['trends']['left_avg_trend'].append(summary['left_avg'])
            comparison['trends']['right_avg_trend'].append(summary['right_avg'])
            comparison['trends']['dissimilarity_trend'].append(summary['dissimilarity'])
        
        # Calculate time span
        if len(session_summaries) > 1:
            time_span = session_summaries[-1]['timestamp'] - session_summaries[0]['timestamp']
            comparison['trends']['time_span_days'] = time_span.days
        
        return jsonify(comparison)
        
    except Exception as e:
        logger.error(f"Session comparison error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


def save_screening_session(user_id, thresholds, left_avg, right_avg, dissimilarity):
    """
    Save a completed screening session for authenticated users only.
    Guest sessions are never saved to maintain privacy.
    
    Creates individual rows in screening_sessions table for each frequency/ear combination.
    """
    try:
        user = User.query.get(user_id)
        if not user or user.auth_type != 'authenticated':
            logger.debug(f"Skipping session save for user {user_id} - not authenticated (type: {user.auth_type if user else 'user not found'})")
            return None
        
        # Generate unique session ID
        session_id = str(uuid.uuid4())
        current_timestamp = db.func.current_timestamp()
        
        # Save individual frequency results as separate rows
        session_rows = []
        for ear in ['left', 'right']:
            for freq_str, threshold in thresholds.get(ear, {}).items():
                try:
                    frequency = int(freq_str)
                    threshold_value = float(threshold)
                    
                    # Create a row for this frequency/ear combination
                    session_row = ScreeningSessions(
                        session_id=session_id,
                        user_id=user_id,
                        timestamp=current_timestamp,
                        ear=ear,
                        frequency_hz=frequency,
                        threshold_db=threshold_value
                    )
                    session_rows.append(session_row)
                    db.session.add(session_row)
                    
                except (ValueError, TypeError) as e:
                    logger.warning(f"Invalid threshold data for {ear} ear at {freq_str}Hz: {e}")
                    continue
        
        if not session_rows:
            logger.warning(f"No valid threshold data to save for user {user_id}")
            return None
        
        db.session.commit()
        logger.info(f"Screening session saved: {session_id} for user {user_id} ({len(session_rows)} frequency results)")
        return session_id
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Failed to save screening session for user {user_id}: {e}")
        return None


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

