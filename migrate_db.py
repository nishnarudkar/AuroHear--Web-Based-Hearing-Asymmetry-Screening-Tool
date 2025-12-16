#!/usr/bin/env python3
"""
Database migration script for AuroHear
Adds new columns to existing PostgreSQL database
"""

from app import app, db

def migrate_database():
    with app.app_context():
        try:
            print("Starting database migration...")
            
            # Check current tables and columns
            inspector = db.inspect(db.engine)
            existing_tables = inspector.get_table_names()
            print(f"Existing tables: {existing_tables}")
            
            # Check user table columns
            if 'user' in existing_tables:
                columns = [c['name'] for c in inspector.get_columns('user')]
                print(f"User table columns: {columns}")
                
                with db.engine.connect() as conn:
                    # Add auth_type column if missing
                    if 'auth_type' not in columns:
                        print('Adding auth_type column...')
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN auth_type VARCHAR(20) DEFAULT \'guest\''))
                        print('✓ auth_type column added')
                    else:
                        print('✓ auth_type column already exists')
                    
                    # Add created_at column if missing
                    if 'created_at' not in columns:
                        print('Adding created_at column...')
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'))
                        print('✓ created_at column added')
                    else:
                        print('✓ created_at column already exists')
                    
                    # Add updated_at column if missing
                    if 'updated_at' not in columns:
                        print('Adding updated_at column...')
                        conn.execute(db.text('ALTER TABLE "user" ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'))
                        print('✓ updated_at column added')
                    else:
                        print('✓ updated_at column already exists')
                    
                    conn.commit()
            
            # Create screening_sessions table if missing (new single-table structure)
            if 'screening_sessions' not in existing_tables:
                print('Creating screening_sessions table...')
                with db.engine.connect() as conn:
                    conn.execute(db.text('''
                        CREATE TABLE screening_sessions (
                            id SERIAL PRIMARY KEY,
                            session_id VARCHAR(36) NOT NULL,
                            user_id INTEGER REFERENCES "user"(id),
                            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                            ear VARCHAR(5) NOT NULL,
                            frequency_hz INTEGER NOT NULL,
                            threshold_db FLOAT NOT NULL
                        )
                    '''))
                    
                    # Create indexes for efficient queries
                    conn.execute(db.text('CREATE INDEX idx_session_user ON screening_sessions(session_id, user_id)'))
                    conn.execute(db.text('CREATE INDEX idx_user_timestamp ON screening_sessions(user_id, timestamp)'))
                    conn.commit()
                print('✓ screening_sessions table created with indexes')
            else:
                print('✓ screening_sessions table already exists')
            
            # Create test_feedback table if missing (new feedback system)
            if 'test_feedback' not in existing_tables:
                print('Creating test_feedback table...')
                with db.engine.connect() as conn:
                    conn.execute(db.text('''
                        CREATE TABLE test_feedback (
                            id SERIAL PRIMARY KEY,
                            session_id VARCHAR(36) NOT NULL,
                            user_id INTEGER REFERENCES "user"(id),
                            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                            test_clarity_rating INTEGER,
                            audio_comfort_rating INTEGER,
                            ease_of_use_rating INTEGER,
                            suggestions_text TEXT,
                            user_agent VARCHAR(500)
                        )
                    '''))
                    
                    # Create indexes for efficient queries
                    conn.execute(db.text('CREATE INDEX idx_feedback_session ON test_feedback(session_id)'))
                    conn.execute(db.text('CREATE INDEX idx_feedback_timestamp ON test_feedback(timestamp)'))
                    conn.commit()
                print('✓ test_feedback table created with indexes')
            else:
                print('✓ test_feedback table already exists')
            
            # Drop old tables if they exist (migration from old structure)
            if 'screening_session' in existing_tables:
                print('Found old screening_session table - consider migrating data before dropping')
                # Uncomment the following lines to drop old tables after data migration
                # with db.engine.connect() as conn:
                #     conn.execute(db.text('DROP TABLE IF EXISTS screening_result'))
                #     conn.execute(db.text('DROP TABLE IF EXISTS screening_session'))
                #     conn.commit()
                # print('✓ Old tables dropped')
            
            if 'screening_result' in existing_tables:
                print('Found old screening_result table - consider migrating data before dropping')
                
            print('✅ Migration completed successfully!')
                
        except Exception as e:
            print(f'❌ Migration error: {e}')
            raise

if __name__ == '__main__':
    migrate_database()