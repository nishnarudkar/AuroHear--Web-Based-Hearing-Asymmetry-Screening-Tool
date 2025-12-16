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


class TestFeedback(db.Model):
    """
    Stores user feedback about the testing experience.
    Separate from audiometric data for privacy and analytics.
    Supports both authenticated and anonymous feedback.
    """
    __tablename__ = 'test_feedback'
    
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.String(36), nullable=False, index=True)  # Links to test session
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)  # Nullable for guest feedback
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp(), nullable=False)
    
    # Rating fields (1-5 scale)
    test_clarity_rating = db.Column(db.Integer, nullable=True)  # How clear were the instructions?
    audio_comfort_rating = db.Column(db.Integer, nullable=True)  # Was the audio comfortable?
    ease_of_use_rating = db.Column(db.Integer, nullable=True)  # How easy was the test to use?
    
    # Optional text feedback
    suggestions_text = db.Column(db.Text, nullable=True)  # "Any suggestions or issues you faced?"
    
    # Metadata
    user_agent = db.Column(db.String(500), nullable=True)  # Browser info for technical issues
    
    # Relationship to user (optional)
    user = db.relationship('User', backref=db.backref('feedback_entries', lazy=True))
    
    def to_dict(self):
        """Convert feedback to dictionary for JSON responses"""
        return {
            'id': self.id,
            'session_id': self.session_id,
            'user_id': self.user_id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'test_clarity_rating': self.test_clarity_rating,
            'audio_comfort_rating': self.audio_comfort_rating,
            'ease_of_use_rating': self.ease_of_use_rating,
            'suggestions_text': self.suggestions_text
        }
    
    @classmethod
    def get_feedback_summary(cls, limit_days=30):
        """Get aggregated feedback statistics for platform improvement"""
        from datetime import datetime, timedelta
        
        cutoff_date = datetime.now() - timedelta(days=limit_days)
        
        feedback_entries = cls.query.filter(cls.timestamp >= cutoff_date).all()
        
        if not feedback_entries:
            return None
        
        # Calculate averages for each rating category
        clarity_ratings = [f.test_clarity_rating for f in feedback_entries if f.test_clarity_rating]
        comfort_ratings = [f.audio_comfort_rating for f in feedback_entries if f.audio_comfort_rating]
        ease_ratings = [f.ease_of_use_rating for f in feedback_entries if f.ease_of_use_rating]
        
        return {
            'period_days': limit_days,
            'total_feedback_count': len(feedback_entries),
            'average_ratings': {
                'test_clarity': sum(clarity_ratings) / len(clarity_ratings) if clarity_ratings else None,
                'audio_comfort': sum(comfort_ratings) / len(comfort_ratings) if comfort_ratings else None,
                'ease_of_use': sum(ease_ratings) / len(ease_ratings) if ease_ratings else None
            },
            'response_counts': {
                'test_clarity': len(clarity_ratings),
                'audio_comfort': len(comfort_ratings),
                'ease_of_use': len(ease_ratings),
                'with_suggestions': len([f for f in feedback_entries if f.suggestions_text])
            }
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
        
        # Calculate interaural differences per frequency
        frequencies = set(r.frequency_hz for r in results)
        interaural_differences = {}
        freq_diffs = []
        
        for freq in frequencies:
            left_val = next((r.threshold_db for r in results if r.ear == 'left' and r.frequency_hz == freq), None)
            right_val = next((r.threshold_db for r in results if r.ear == 'right' and r.frequency_hz == freq), None)
            
            if left_val is not None and right_val is not None:
                # Calculate absolute difference (no directional bias)
                abs_diff = abs(left_val - right_val)
                # Calculate signed difference (left - right, for trend analysis)
                signed_diff = left_val - right_val
                
                interaural_differences[freq] = {
                    'left_threshold': left_val,
                    'right_threshold': right_val,
                    'absolute_difference': abs_diff,
                    'signed_difference': signed_diff,  # Positive = left worse, Negative = right worse
                    'frequency_hz': freq
                }
                
                freq_diffs.append(abs_diff)
        
        # Add interaural analysis to summary
        summary['interaural_differences'] = interaural_differences
        summary['dissimilarity'] = max(freq_diffs) if freq_diffs else None
        
        # Calculate additional interaural statistics
        if freq_diffs:
            summary['interaural_stats'] = {
                'max_difference': max(freq_diffs),
                'min_difference': min(freq_diffs),
                'mean_difference': sum(freq_diffs) / len(freq_diffs),
                'frequencies_with_differences': len([d for d in freq_diffs if d > 0]),
                'total_frequencies_compared': len(freq_diffs)
            }
        else:
            summary['interaural_stats'] = None
        
        return summary
    
    @classmethod
    def compute_interaural_differences(cls, thresholds):
        """
        Compute interaural threshold differences from threshold data.
        
        Args:
            thresholds: Dict with 'left' and 'right' keys containing frequency->threshold mappings
            
        Returns:
            Dict containing per-frequency differences and summary statistics
        """
        if not thresholds or 'left' not in thresholds or 'right' not in thresholds:
            return None
        
        left_data = thresholds['left']
        right_data = thresholds['right']
        
        # Find common frequencies
        common_frequencies = set(left_data.keys()) & set(right_data.keys())
        
        if not common_frequencies:
            return None
        
        differences = {}
        abs_diffs = []
        signed_diffs = []
        
        for freq in common_frequencies:
            try:
                freq_int = int(freq)
                left_val = float(left_data[freq])
                right_val = float(right_data[freq])
                
                abs_diff = abs(left_val - right_val)
                signed_diff = left_val - right_val
                
                differences[freq_int] = {
                    'left_threshold': left_val,
                    'right_threshold': right_val,
                    'absolute_difference': abs_diff,
                    'signed_difference': signed_diff,
                    'frequency_hz': freq_int
                }
                
                abs_diffs.append(abs_diff)
                signed_diffs.append(signed_diff)
                
            except (ValueError, TypeError):
                continue
        
        if not abs_diffs:
            return None
        
        return {
            'per_frequency': differences,
            'summary_stats': {
                'max_absolute_difference': max(abs_diffs),
                'min_absolute_difference': min(abs_diffs),
                'mean_absolute_difference': sum(abs_diffs) / len(abs_diffs),
                'max_signed_difference': max(signed_diffs),
                'min_signed_difference': min(signed_diffs),
                'mean_signed_difference': sum(signed_diffs) / len(signed_diffs),
                'frequencies_compared': len(abs_diffs),
                'total_frequencies': len(common_frequencies)
            }
        }
    
    @classmethod
    def analyze_session_trends(cls, user_id, limit=10):
        """
        Analyze trends in user's session history using simple heuristics.
        
        Classifies patterns as:
        - Stable: Low variance across sessions
        - Variable: Moderate variance, normal fluctuation
        - Changing: High variance or clear directional trend
        
        Args:
            user_id: User ID to analyze
            limit: Maximum number of recent sessions to analyze
            
        Returns:
            Dict containing trend analysis without medical interpretation
        """
        try:
            # Get recent sessions for this user
            sessions = db.session.query(cls).filter_by(user_id=user_id)\
                .order_by(cls.timestamp.desc()).limit(limit * 12).all()  # 12 frequencies per session
            
            if len(sessions) < 12:  # Need at least one complete session
                return {
                    'classification': 'insufficient_data',
                    'sessions_analyzed': 0,
                    'note': 'Need at least one complete session for trend analysis'
                }
            
            # Group by session_id and calculate session averages
            session_summaries = {}
            for result in sessions:
                session_id = result.session_id
                if session_id not in session_summaries:
                    session_summaries[session_id] = {
                        'timestamp': result.timestamp,
                        'left_thresholds': [],
                        'right_thresholds': [],
                        'interaural_diffs': []
                    }
                
                # Find matching frequency in opposite ear for interaural difference
                opposite_ear = 'right' if result.ear == 'left' else 'left'
                opposite_result = next((r for r in sessions 
                                      if r.session_id == session_id 
                                      and r.ear == opposite_ear 
                                      and r.frequency_hz == result.frequency_hz), None)
                
                if result.ear == 'left':
                    session_summaries[session_id]['left_thresholds'].append(result.threshold_db)
                else:
                    session_summaries[session_id]['right_thresholds'].append(result.threshold_db)
                
                if opposite_result:
                    interaural_diff = abs(result.threshold_db - opposite_result.threshold_db)
                    session_summaries[session_id]['interaural_diffs'].append(interaural_diff)
            
            # Calculate session-level metrics
            session_metrics = []
            for session_id, data in session_summaries.items():
                if len(data['left_thresholds']) >= 3 and len(data['right_thresholds']) >= 3:
                    left_avg = sum(data['left_thresholds']) / len(data['left_thresholds'])
                    right_avg = sum(data['right_thresholds']) / len(data['right_thresholds'])
                    max_interaural = max(data['interaural_diffs']) if data['interaural_diffs'] else 0
                    
                    session_metrics.append({
                        'session_id': session_id,
                        'timestamp': data['timestamp'],
                        'left_avg': left_avg,
                        'right_avg': right_avg,
                        'overall_avg': (left_avg + right_avg) / 2,
                        'max_interaural_diff': max_interaural
                    })
            
            if len(session_metrics) < 2:
                return {
                    'classification': 'insufficient_data',
                    'sessions_analyzed': len(session_metrics),
                    'note': 'Need at least 2 complete sessions for trend analysis'
                }
            
            # Sort by timestamp for trend analysis
            session_metrics.sort(key=lambda x: x['timestamp'])
            
            # Calculate variance metrics
            overall_avgs = [s['overall_avg'] for s in session_metrics]
            left_avgs = [s['left_avg'] for s in session_metrics]
            right_avgs = [s['right_avg'] for s in session_metrics]
            interaural_maxes = [s['max_interaural_diff'] for s in session_metrics]
            
            # Simple variance calculation
            def calculate_variance(values):
                if len(values) < 2:
                    return 0
                mean_val = sum(values) / len(values)
                return sum((x - mean_val) ** 2 for x in values) / len(values)
            
            overall_variance = calculate_variance(overall_avgs)
            left_variance = calculate_variance(left_avgs)
            right_variance = calculate_variance(right_avgs)
            interaural_variance = calculate_variance(interaural_maxes)
            
            # Simple trend detection (linear)
            def calculate_trend(values):
                if len(values) < 3:
                    return 0
                # Simple slope calculation
                n = len(values)
                x_vals = list(range(n))
                x_mean = sum(x_vals) / n
                y_mean = sum(values) / n
                
                numerator = sum((x_vals[i] - x_mean) * (values[i] - y_mean) for i in range(n))
                denominator = sum((x_vals[i] - x_mean) ** 2 for i in range(n))
                
                return numerator / denominator if denominator != 0 else 0
            
            overall_trend = calculate_trend(overall_avgs)
            interaural_trend = calculate_trend(interaural_maxes)
            
            # Classification heuristics (non-medical)
            # Thresholds based on typical audiometric variability
            stable_threshold = 25  # Low variance threshold (dB²)
            variable_threshold = 100  # Moderate variance threshold (dB²)
            trend_threshold = 2.0  # Significant trend threshold (dB per session)
            
            # Determine classification
            max_variance = max(overall_variance, left_variance, right_variance)
            significant_trend = abs(overall_trend) > trend_threshold or abs(interaural_trend) > 1.0
            
            if max_variance <= stable_threshold and not significant_trend:
                classification = 'stable'
                description = 'Consistent measurements across sessions'
            elif max_variance <= variable_threshold and not significant_trend:
                classification = 'variable'
                description = 'Normal fluctuation in measurements'
            else:
                classification = 'changing'
                if significant_trend:
                    trend_direction = 'increasing' if overall_trend > 0 else 'decreasing'
                    description = f'Notable variation with {trend_direction} trend'
                else:
                    description = 'High variation in measurements'
            
            return {
                'classification': classification,
                'description': description,
                'sessions_analyzed': len(session_metrics),
                'time_span_days': (session_metrics[-1]['timestamp'] - session_metrics[0]['timestamp']).days,
                'metrics': {
                    'overall_variance': round(overall_variance, 2),
                    'left_ear_variance': round(left_variance, 2),
                    'right_ear_variance': round(right_variance, 2),
                    'interaural_variance': round(interaural_variance, 2),
                    'overall_trend_slope': round(overall_trend, 2),
                    'interaural_trend_slope': round(interaural_trend, 2)
                },
                'session_range': {
                    'earliest': session_metrics[0]['timestamp'].isoformat(),
                    'latest': session_metrics[-1]['timestamp'].isoformat(),
                    'first_avg': round(session_metrics[0]['overall_avg'], 1),
                    'last_avg': round(session_metrics[-1]['overall_avg'], 1)
                },
                'disclaimer': 'Trend analysis provides objective measurement patterns only. No clinical interpretation is provided.'
            }
            
        except Exception as e:
            logger.error(f"Trend analysis error for user {user_id}: {e}")
            return {
                'classification': 'analysis_error',
                'sessions_analyzed': 0,
                'note': 'Unable to compute trend analysis'
            }
    
    @classmethod
    def generate_educational_summary(cls, user_id, limit=10):
        """
        Generate neutral, educational summaries based on multiple sessions.
        
        Provides objective observations about measurement patterns while
        avoiding clinical language and reinforcing medical disclaimers.
        
        Args:
            user_id: User ID to analyze
            limit: Maximum number of recent sessions to analyze
            
        Returns:
            Dict containing educational summary with appropriate disclaimers
        """
        try:
            # Get trend analysis first
            trend_analysis = cls.analyze_session_trends(user_id, limit)
            
            if trend_analysis['classification'] in ['insufficient_data', 'analysis_error']:
                return {
                    'summary_type': 'insufficient_data',
                    'title': 'Measurement History Summary',
                    'main_message': 'Not enough screening sessions available for pattern analysis.',
                    'recommendations': [
                        'Complete additional screening sessions to track measurement patterns over time',
                        'Regular screening can help monitor hearing awareness'
                    ],
                    'disclaimer': 'This screening tool provides preliminary measurements only and does not replace professional audiological assessment.'
                }
            
            # Generate summary based on classification
            classification = trend_analysis['classification']
            sessions_count = trend_analysis['sessions_analyzed']
            time_span = trend_analysis['time_span_days']
            metrics = trend_analysis.get('metrics', {})
            session_range = trend_analysis.get('session_range', {})
            
            # Base summary structure
            summary = {
                'summary_type': 'pattern_analysis',
                'title': f'Measurement Pattern Summary ({sessions_count} Sessions)',
                'analysis_period': f'{time_span} days' if time_span > 0 else 'Multiple sessions',
                'pattern_classification': classification,
                'main_message': '',
                'key_observations': [],
                'educational_notes': [],
                'recommendations': [],
                'disclaimer': 'This analysis provides objective measurement observations only. It is not a medical assessment and does not replace professional audiological evaluation.'
            }
            
            # Generate classification-specific content
            if classification == 'stable':
                summary['main_message'] = 'Your hearing screening measurements show consistent patterns across multiple sessions.'
                
                summary['key_observations'] = [
                    f'Measurements remained relatively consistent over {sessions_count} screening sessions',
                    f'Low variability observed in threshold measurements (variance: {metrics.get("overall_variance", "N/A")} dB²)',
                    'Both ears showed similar consistency patterns' if metrics.get('left_ear_variance', 0) < 30 and metrics.get('right_ear_variance', 0) < 30 else 'Measurement consistency varied between ears'
                ]
                
                summary['educational_notes'] = [
                    'Consistent measurements suggest stable hearing awareness during the screening period',
                    'Normal day-to-day variation in hearing tests is typically 5-10 dB',
                    'Environmental factors and test conditions can influence screening results'
                ]
                
                summary['recommendations'] = [
                    'Continue periodic screening to maintain awareness of hearing status',
                    'Consider annual professional hearing evaluations as part of routine healthcare'
                ]
            
            elif classification == 'variable':
                summary['main_message'] = 'Your hearing screening measurements show normal variation across multiple sessions.'
                
                # Calculate variation details
                overall_var = metrics.get('overall_variance', 0)
                left_var = metrics.get('left_ear_variance', 0)
                right_var = metrics.get('right_ear_variance', 0)
                
                summary['key_observations'] = [
                    f'Moderate variation observed across {sessions_count} screening sessions',
                    f'Overall measurement variability: {overall_var} dB² (within expected range)',
                    f'Left ear variability: {left_var} dB², Right ear variability: {right_var} dB²',
                    'Variation patterns are within typical ranges for screening measurements'
                ]
                
                summary['educational_notes'] = [
                    'Some variation in hearing screening results is normal and expected',
                    'Factors affecting measurement variation include ambient noise, headphone positioning, and attention level',
                    'Screening tools have inherent measurement variability compared to clinical audiometry'
                ]
                
                summary['recommendations'] = [
                    'Continue regular screening to monitor patterns over time',
                    'Ensure consistent testing conditions (quiet environment, proper headphone fit)',
                    'Consider professional evaluation if you notice hearing changes in daily life'
                ]
            
            elif classification == 'changing':
                summary['main_message'] = 'Your hearing screening measurements show notable variation or trends across multiple sessions.'
                
                # Analyze trend direction
                trend_slope = metrics.get('overall_trend_slope', 0)
                interaural_trend = metrics.get('interaural_trend_slope', 0)
                
                trend_direction = 'increasing' if trend_slope > 1 else 'decreasing' if trend_slope < -1 else 'variable'
                
                summary['key_observations'] = [
                    f'Significant variation observed across {sessions_count} screening sessions',
                    f'Overall measurement trend: {trend_direction} pattern detected',
                    f'Measurement variability: {metrics.get("overall_variance", "N/A")} dB² (above typical range)',
                    'Pattern suggests changes in screening measurements over time'
                ]
                
                summary['educational_notes'] = [
                    'Notable changes in screening measurements may indicate various factors',
                    'Possible influences include environmental changes, equipment differences, or hearing changes',
                    'Screening tools can detect measurement patterns but cannot determine underlying causes'
                ]
                
                summary['recommendations'] = [
                    'Consider professional audiological evaluation to assess hearing status',
                    'Discuss measurement patterns with a healthcare provider',
                    'Continue monitoring with consistent screening conditions',
                    'Seek professional evaluation if experiencing hearing difficulties in daily activities'
                ]
            
            # Add time-based context
            if time_span > 0:
                if time_span < 30:
                    summary['educational_notes'].append('Short-term measurement patterns may be influenced by temporary factors')
                elif time_span > 180:
                    summary['educational_notes'].append('Long-term measurement tracking provides valuable hearing awareness information')
            
            # Add session range context if available
            if session_range.get('first_avg') and session_range.get('last_avg'):
                first_avg = session_range['first_avg']
                last_avg = session_range['last_avg']
                change = abs(last_avg - first_avg)
                
                if change > 10:
                    summary['key_observations'].append(f'Overall average changed by {change:.1f} dB from first to most recent session')
                else:
                    summary['key_observations'].append(f'Overall average remained stable (change: {change:.1f} dB)')
            
            # Add interaural analysis context
            interaural_var = metrics.get('interaural_variance', 0)
            if interaural_var > 0:
                if interaural_var < 10:
                    summary['educational_notes'].append('Interaural (between-ear) differences remained consistent across sessions')
                else:
                    summary['educational_notes'].append('Interaural (between-ear) differences showed variation across sessions')
            
            return summary
            
        except Exception as e:
            logger.error(f"Educational summary generation error for user {user_id}: {e}")
            return {
                'summary_type': 'generation_error',
                'title': 'Summary Generation Error',
                'main_message': 'Unable to generate measurement summary at this time.',
                'recommendations': ['Try again later or contact support if the issue persists'],
                'disclaimer': 'This screening tool provides preliminary measurements only and does not replace professional audiological assessment.'
            }

def run_migrations():
    """Database migration for both SQLite and PostgreSQL"""
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
            
            # Create test_feedback table if it doesn't exist
            if not inspector.has_table('test_feedback'):
                logger.info("Creating test_feedback table")
                TestFeedback.__table__.create(db.engine)
                
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

# Run migration on import/start for both SQLite and PostgreSQL
try:
    run_migrations()
    logger.info("Database migration completed successfully")
except Exception as e:
    logger.warning(f"Migration failed (might be already done): {e}")
    # Try to create all tables as fallback
    try:
        with app.app_context():
            db.create_all()
        logger.info("Fallback table creation completed")
    except Exception as fallback_error:
        logger.error(f"Fallback table creation also failed: {fallback_error}")


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
        level_db = float(request.args.get('level_db', 40))  # Add dB level parameter

        if freq < 20 or freq > 20000:
            return ("Frequency out of audible range (20-20000 Hz)", 400)

        # Proper audiometric volume calculation using logarithmic dB scaling
        # Convert dB HL to linear amplitude (proper audiometric formula)
        # Reference: 40 dB HL = comfortable listening level (volume = 1.0)
        
        # Calculate amplitude using proper dB formula: amplitude = 10^((dB - reference_dB) / 20)
        reference_db = 40  # 40 dB HL as reference level
        amplitude = 10 ** ((level_db - reference_db) / 20)
        
        # Apply user volume scaling
        final_volume = amplitude * volume
        
        # Clamp to valid range (no minimum volume enforcement for proper thresholding)
        final_volume = max(0.0, min(1.0, final_volume))
        
        # Log volume calculation for debugging
        logger.info(f"Tone generation: freq={freq}Hz, level_db={level_db}dB, input_volume={volume}, final_volume={final_volume}")

        sample_rate = 44100
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        note = np.sin(2 * np.pi * freq * t) * final_volume

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

        # Maximum scaling for production environments - ensure audibility
        scaling_factor = 1.0  # Maximum scaling for production
        audio_int16 = (audio * 32767 * scaling_factor).astype(np.int16)
        
        # Ensure audio data is not empty or silent
        if np.max(np.abs(audio_int16)) == 0:
            logger.warning("Generated audio is silent, creating minimum audible tone")
            # Create a minimum audible tone as fallback
            min_tone = np.sin(2 * np.pi * freq * t) * 0.3
            if channel == 'both':
                min_audio = np.column_stack((min_tone, min_tone))
            elif channel == 'left':
                min_audio = np.column_stack((min_tone, np.zeros_like(min_tone)))
            else:  # 'right'
                min_audio = np.column_stack((np.zeros_like(min_tone), min_tone))
            audio_int16 = (min_audio * 32767 * 0.5).astype(np.int16)

        bio = BytesIO()
        write(bio, sample_rate, audio_int16)
        bio.seek(0)
        
        audio_data = bio.getvalue()
        
        # Validate audio data
        if len(audio_data) < 100:  # WAV header should be at least 44 bytes + some data
            logger.error(f"Generated audio data too small: {len(audio_data)} bytes")
            return ("Audio generation failed - insufficient data", 500)
        
        logger.info(f"Generated audio: {len(audio_data)} bytes, freq={freq}Hz, duration={duration}s, volume={final_volume}")
        
        # Add headers for better audio streaming and compatibility
        response = Response(audio_data, mimetype='audio/wav')
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        response.headers['Content-Length'] = str(len(audio_data))
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Access-Control-Allow-Origin'] = '*'
        
        return response
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
            
            # Compute interaural differences for this session
            interaural_analysis = ScreeningSessions.compute_interaural_differences(thresholds)
            
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
                'interaural_differences': {
                    'per_frequency': interaural_analysis['per_frequency'] if interaural_analysis else {},
                    'summary_stats': interaural_analysis['summary_stats'] if interaural_analysis else None,
                    'has_analysis': interaural_analysis is not None
                },
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
        
        # Add trend analysis and educational summary if sufficient data
        trend_analysis = None
        educational_summary = None
        
        if total_sessions >= 2:
            try:
                trend_analysis = ScreeningSessions.analyze_session_trends(user.id, min(total_sessions, 10))
                educational_summary = ScreeningSessions.generate_educational_summary(user.id, min(total_sessions, 10))
            except Exception as e:
                logger.warning(f"Analysis failed for user {user_id}: {e}")
        
        logger.info(f"Retrieved {len(history)} test sessions for authenticated user {user_id}")
        
        return jsonify({
            'user_id': user.id,
            'user_type': user.auth_type,
            'statistics': summary_stats,
            'trend_analysis': trend_analysis,
            'educational_summary': educational_summary,
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


@app.route('/user/interaural-analysis', methods=['POST'])
def analyze_interaural_differences():
    """
    Analyze interaural threshold differences for given threshold data.
    
    Request Body:
    - thresholds (required): Object with 'left' and 'right' ear data
    - user_id (optional): For access logging
    
    Returns:
    - Per-frequency interaural differences
    - Summary statistics
    - No diagnostic interpretation or severity assignment
    """
    data = request.json or {}
    thresholds = data.get('thresholds')
    user_id = data.get('user_id')
    
    if not thresholds:
        return jsonify({'error': 'Threshold data required'}), 400
    
    try:
        # Compute interaural differences
        analysis = ScreeningSessions.compute_interaural_differences(thresholds)
        
        if not analysis:
            return jsonify({
                'error': 'Unable to compute differences - insufficient data',
                'details': 'Need matching frequency data for both ears'
            }), 400
        
        # Log analysis request (without sensitive data)
        if user_id:
            logger.info(f"Interaural analysis requested by user {user_id}")
        
        from datetime import datetime
        response_data = {
            'analysis_type': 'interaural_threshold_differences',
            'timestamp': datetime.now().isoformat(),
            'frequencies_analyzed': analysis['summary_stats']['frequencies_compared'],
            'per_frequency_differences': analysis['per_frequency'],
            'summary_statistics': analysis['summary_stats'],
            'notes': {
                'measurement_unit': 'dB HL',
                'difference_calculation': 'absolute_difference = |left - right|',
                'signed_difference_interpretation': 'positive = left ear higher threshold (worse), negative = right ear higher threshold (worse)',
                'disclaimer': 'This analysis provides objective measurements only. No diagnostic interpretation is provided.'
            }
        }
        
        return jsonify(response_data)
        
    except Exception as e:
        logger.error(f"Interaural analysis error: {e}")
        return jsonify({'error': 'Analysis computation failed'}), 500


@app.route('/user/session/<session_id>/interaural-analysis', methods=['GET'])
def get_session_interaural_analysis(session_id):
    """
    Get detailed interaural analysis for a specific session.
    
    Path Parameters:
    - session_id: UUID of the screening session
    
    Query Parameters:
    - user_id (required): User ID for access control
    
    Returns:
    - Comprehensive interaural difference analysis for the session
    - Per-frequency comparisons
    - Summary statistics without diagnostic interpretation
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
            return jsonify({'error': 'Interaural analysis only available for authenticated users'}), 403
        
        # Get session data and verify ownership
        results = ScreeningSessions.query.filter_by(
            session_id=session_id, 
            user_id=user.id
        ).all()
        
        if not results:
            return jsonify({'error': 'Session not found or access denied'}), 404
        
        # Get session summary with interaural analysis
        summary = ScreeningSessions.get_session_summary(session_id)
        
        if not summary or not summary.get('interaural_differences'):
            return jsonify({
                'error': 'Insufficient data for interaural analysis',
                'details': 'Need threshold data for both ears at matching frequencies'
            }), 400
        
        # Organize response data
        analysis_data = {
            'session_id': session_id,
            'timestamp': summary['timestamp'].isoformat(),
            'analysis_type': 'session_interaural_differences',
            'per_frequency_analysis': summary['interaural_differences'],
            'summary_statistics': summary['interaural_stats'],
            'session_metadata': {
                'total_frequencies': summary['frequency_count'],
                'ears_tested': summary['ears_tested'],
                'left_ear_average': summary['left_avg'],
                'right_ear_average': summary['right_avg']
            },
            'measurement_details': {
                'unit': 'dB HL',
                'calculation_method': 'Per-frequency absolute difference |left - right|',
                'signed_difference_meaning': 'Positive = left ear worse, Negative = right ear worse',
                'max_difference_frequency': None,
                'min_difference_frequency': None
            }
        }
        
        # Find frequencies with max and min differences
        if summary['interaural_differences']:
            max_diff = 0
            min_diff = float('inf')
            max_freq = None
            min_freq = None
            
            for freq, data in summary['interaural_differences'].items():
                abs_diff = data['absolute_difference']
                if abs_diff > max_diff:
                    max_diff = abs_diff
                    max_freq = freq
                if abs_diff < min_diff:
                    min_diff = abs_diff
                    min_freq = freq
            
            analysis_data['measurement_details']['max_difference_frequency'] = max_freq
            analysis_data['measurement_details']['min_difference_frequency'] = min_freq
        
        return jsonify(analysis_data)
        
    except Exception as e:
        logger.error(f"Session interaural analysis error for session {session_id}: {e}")
        return jsonify({'error': 'Analysis computation failed'}), 500


@app.route('/user/trend-analysis', methods=['GET'])
def get_user_trend_analysis():
    """
    Analyze trends in user session history using simple heuristics.
    
    Query Parameters:
    - user_id (required): User ID for access control
    - limit (optional): Maximum number of recent sessions to analyze (default: 10)
    
    Returns:
    - Trend classification: stable, variable, or changing
    - Objective metrics without medical interpretation
    - Simple variance and trend calculations
    """
    user_id = request.args.get('user_id')
    limit = min(int(request.args.get('limit', 10)), 20)  # Cap at 20 sessions
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        # Verify user authentication
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        if user.auth_type != 'authenticated':
            return jsonify({'error': 'Trend analysis only available for authenticated users'}), 403
        
        # Perform trend analysis
        trend_analysis = ScreeningSessions.analyze_session_trends(user.id, limit)
        
        # Add user context
        from datetime import datetime
        from datetime import datetime
        response_data = {
            'user_id': user.id,
            'analysis_timestamp': datetime.now().isoformat(),
            'trend_analysis': trend_analysis,
            'methodology': {
                'classification_types': {
                    'stable': 'Low variance across sessions (≤25 dB²)',
                    'variable': 'Moderate variance, normal fluctuation (≤100 dB²)',
                    'changing': 'High variance or clear directional trend (>100 dB² or >2 dB/session)'
                },
                'metrics_calculated': [
                    'Variance in overall hearing thresholds',
                    'Variance in left and right ear averages',
                    'Variance in interaural differences',
                    'Linear trend slopes over time'
                ],
                'disclaimer': 'Analysis provides objective measurement patterns only. No predictive modeling or medical interpretation.'
            }
        }
        
        logger.info(f"Trend analysis completed for user {user_id}: {trend_analysis['classification']}")
        return jsonify(response_data)
        
    except Exception as e:
        logger.error(f"Trend analysis error for user {user_id}: {e}")
        return jsonify({'error': 'Trend analysis computation failed'}), 500


@app.route('/user/measurement-summary', methods=['GET'])
def get_measurement_summary():
    """
    Generate neutral, educational summary based on multiple sessions.
    
    Query Parameters:
    - user_id (required): User ID for access control
    - limit (optional): Maximum number of recent sessions to analyze (default: 10)
    
    Returns:
    - Educational summary highlighting consistency or variability
    - Neutral language avoiding clinical interpretation
    - Appropriate medical disclaimers and professional consultation guidance
    """
    user_id = request.args.get('user_id')
    limit = min(int(request.args.get('limit', 10)), 20)  # Cap at 20 sessions
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        # Verify user authentication
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        if user.auth_type != 'authenticated':
            return jsonify({'error': 'Measurement summary only available for authenticated users'}), 403
        
        # Generate educational summary
        summary = ScreeningSessions.generate_educational_summary(user.id, limit)
        
        # Add user context and metadata
        from datetime import datetime
        response_data = {
            'user_id': user.id,
            'generated_at': datetime.now().isoformat(),
            'summary': summary,
            'important_notes': {
                'screening_nature': 'This is a preliminary screening tool, not a diagnostic test',
                'professional_evaluation': 'Professional audiological assessment is recommended for comprehensive hearing evaluation',
                'measurement_limitations': 'Screening measurements may be influenced by environmental factors and equipment variations',
                'consultation_guidance': 'Consult healthcare providers for hearing concerns or questions about results'
            },
            'when_to_seek_professional_help': [
                'Sudden changes in hearing ability',
                'Persistent tinnitus (ringing in ears)',
                'Difficulty understanding speech in noisy environments',
                'Concerns about hearing loss affecting daily activities',
                'Family history of hearing loss',
                'Exposure to loud noises or ototoxic medications'
            ]
        }
        
        logger.info(f"Educational summary generated for user {user_id}: {summary['summary_type']}")
        return jsonify(response_data)
        
    except Exception as e:
        logger.error(f"Measurement summary error for user {user_id}: {e}")
        return jsonify({'error': 'Summary generation failed'}), 500


@app.route('/submit_feedback', methods=['POST'])
def submit_feedback():
    """
    Submit user feedback about the testing experience.
    
    Request Body:
    - session_id (required): UUID of the test session
    - user_id (optional): User ID for authenticated users
    - test_clarity_rating (optional): 1-5 rating for instruction clarity
    - audio_comfort_rating (optional): 1-5 rating for audio comfort
    - ease_of_use_rating (optional): 1-5 rating for ease of use
    - suggestions_text (optional): Free text suggestions/issues
    
    Returns:
    - Success confirmation without exposing stored data
    """
    data = request.json or {}
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    
    if not session_id:
        return jsonify({'error': 'Session ID required'}), 400
    
    try:
        # Validate ratings are in 1-5 range if provided
        rating_fields = ['test_clarity_rating', 'audio_comfort_rating', 'ease_of_use_rating']
        for field in rating_fields:
            rating = data.get(field)
            if rating is not None:
                try:
                    rating_val = int(rating)
                    if rating_val < 1 or rating_val > 5:
                        return jsonify({'error': f'{field} must be between 1 and 5'}), 400
                except (ValueError, TypeError):
                    return jsonify({'error': f'{field} must be a valid integer'}), 400
        
        # Validate suggestions text length (prevent abuse)
        suggestions_text = data.get('suggestions_text', '').strip()
        if len(suggestions_text) > 1000:  # Reasonable limit
            return jsonify({'error': 'Suggestions text too long (max 1000 characters)'}), 400
        
        # Get user agent for technical debugging (no personal data)
        user_agent = request.headers.get('User-Agent', '')[:500]  # Truncate to prevent overflow
        
        # Create feedback entry
        feedback = TestFeedback(
            session_id=session_id,
            user_id=user_id if user_id else None,  # Allow anonymous feedback
            test_clarity_rating=data.get('test_clarity_rating'),
            audio_comfort_rating=data.get('audio_comfort_rating'),
            ease_of_use_rating=data.get('ease_of_use_rating'),
            suggestions_text=suggestions_text if suggestions_text else None,
            user_agent=user_agent
        )
        
        db.session.add(feedback)
        db.session.commit()
        
        # Log feedback submission (without personal data)
        feedback_type = 'authenticated' if user_id else 'anonymous'
        logger.info(f"Feedback submitted: session={session_id[:8]}..., type={feedback_type}")
        
        return jsonify({
            'success': True,
            'message': 'Thank you for your feedback! It helps us improve the platform.',
            'feedback_id': feedback.id  # Safe to return for confirmation
        })
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Feedback submission error for session {session_id}: {e}")
        return jsonify({'error': 'Failed to submit feedback'}), 500


@app.route('/feedback/summary', methods=['GET'])
def get_feedback_summary():
    """
    Get aggregated feedback statistics for platform improvement.
    Admin/development endpoint - no personal data exposed.
    
    Query Parameters:
    - days (optional): Number of days to include (default: 30, max: 365)
    
    Returns:
    - Aggregated statistics without personal identifiers
    """
    try:
        days = min(int(request.args.get('days', 30)), 365)  # Cap at 1 year
        
        summary = TestFeedback.get_feedback_summary(limit_days=days)
        
        if not summary:
            return jsonify({
                'period_days': days,
                'message': 'No feedback data available for the specified period'
            })
        
        return jsonify(summary)
        
    except ValueError:
        return jsonify({'error': 'Invalid days parameter'}), 400
    except Exception as e:
        logger.error(f"Feedback summary error: {e}")
        return jsonify({'error': 'Failed to generate feedback summary'}), 500


@app.route('/save_results', methods=['POST'])
def save_results():
    """
    Save aggregated test results for authenticated users.
    This endpoint is called by the JavaScript frontend after test completion.
    """
    data = request.json or {}
    user_id = data.get('user_id')
    left_avg = data.get('left_avg')
    right_avg = data.get('right_avg')
    dissimilarity = data.get('dissimilarity')
    
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400
    
    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        # Only save for authenticated users (privacy-first approach)
        if user.auth_type != 'authenticated':
            logger.debug(f"Skipping results save for user {user_id} - guest session (privacy protected)")
            return jsonify({
                'success': True,
                'message': 'Guest session - results not stored for privacy',
                'session_id': None
            })
        
        # Update user's latest results
        if left_avg is not None:
            user.left_avg = float(left_avg)
        if right_avg is not None:
            user.right_avg = float(right_avg)
        if dissimilarity is not None:
            user.dissimilarity = float(dissimilarity)
        
        db.session.commit()
        logger.info(f"Results saved for authenticated user {user_id}: L={left_avg}, R={right_avg}, D={dissimilarity}")
        
        return jsonify({
            'success': True,
            'message': 'Results saved successfully',
            'user_id': user_id
        })
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"Save results error for user {user_id}: {e}")
        return jsonify({'error': str(e)}), 500


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
        from datetime import datetime
        session_id = str(uuid.uuid4())
        current_timestamp = datetime.now()
        
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

