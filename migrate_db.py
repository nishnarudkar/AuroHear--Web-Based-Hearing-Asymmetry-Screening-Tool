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
            
            # Create screening_session table if missing
            if 'screening_session' not in existing_tables:
                print('Creating screening_session table...')
                with db.engine.connect() as conn:
                    conn.execute(db.text('''
                        CREATE TABLE screening_session (
                            id SERIAL PRIMARY KEY,
                            session_id VARCHAR(36) UNIQUE NOT NULL,
                            user_id INTEGER REFERENCES "user"(id),
                            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                            left_avg FLOAT,
                            right_avg FLOAT,
                            dissimilarity FLOAT
                        )
                    '''))
                    conn.commit()
                print('✓ screening_session table created')
            else:
                print('✓ screening_session table already exists')
            
            # Create screening_result table if missing
            if 'screening_result' not in existing_tables:
                print('Creating screening_result table...')
                with db.engine.connect() as conn:
                    conn.execute(db.text('''
                        CREATE TABLE screening_result (
                            id SERIAL PRIMARY KEY,
                            session_id VARCHAR(36) REFERENCES screening_session(session_id) NOT NULL,
                            ear VARCHAR(5) NOT NULL,
                            frequency_hz INTEGER NOT NULL,
                            threshold_db FLOAT NOT NULL
                        )
                    '''))
                    conn.commit()
                print('✓ screening_result table created')
            else:
                print('✓ screening_result table already exists')
                
            print('✅ Migration completed successfully!')
                
        except Exception as e:
            print(f'❌ Migration error: {e}')
            raise

if __name__ == '__main__':
    migrate_database()