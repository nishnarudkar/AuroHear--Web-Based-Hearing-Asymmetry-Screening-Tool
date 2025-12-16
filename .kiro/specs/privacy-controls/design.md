# Privacy Controls and Future Expansion Design Document

## Overview

This design document outlines the technical implementation of comprehensive privacy controls, Row-Level Security (RLS), user data control panels, and future expansion capabilities for the AuroHear hearing screening application. The solution maintains the existing lightweight architecture while adding robust security, privacy controls, and extensibility features.

## Architecture

### High-Level Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Flask App      │    │   Supabase      │
│   (Vanilla JS)  │◄──►│   (Python)       │◄──►│   (PostgreSQL)  │
│                 │    │                  │    │   + RLS         │
│ • Data Panel    │    │ • Privacy APIs   │    │                 │
│ • Export UI     │    │ • RLS Context    │    │ • Row Policies  │
│ • Confirmations │    │ • Audit Logging  │    │ • Audit Tables  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Privacy-First Design Principles

1. **Zero Trust Architecture**: Every data access requires explicit authorization
2. **Database-Level Security**: RLS policies enforce access control at the lowest level
3. **Minimal Data Collection**: Only essential data is stored and processed
4. **User Empowerment**: Complete user control over their data lifecycle
5. **Audit Everything**: Comprehensive logging for compliance and security

## Components and Interfaces

### 1. Row-Level Security (RLS) Implementation

#### Database Schema Updates

```sql
-- Enable RLS on existing tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_sessions ENABLE ROW LEVEL SECURITY;

-- Create audit log table
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(50) NOT NULL,
    record_id VARCHAR(50),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT,
    details JSONB
);

-- Create data export requests table
CREATE TABLE data_export_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_type VARCHAR(20) NOT NULL, -- 'full', 'partial', 'sessions_only'
    format VARCHAR(10) NOT NULL, -- 'csv', 'json'
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    filters JSONB, -- For partial exports
    file_path TEXT, -- S3/storage path when completed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days')
);

-- Create data deletion requests table
CREATE TABLE data_deletion_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    deletion_type VARCHAR(20) NOT NULL, -- 'full', 'partial', 'sessions_only'
    confirmation_token VARCHAR(64) NOT NULL,
    confirmation_phrase VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'confirmed', 'processing', 'completed', 'cancelled'
    grace_period_ends TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    completed_at TIMESTAMP,
    details JSONB
);
```

#### RLS Policies

```sql
-- Users table policies
CREATE POLICY users_select_own ON users 
    FOR SELECT USING (
        supabase_id = current_setting('app.current_user_id', true)::text
        OR auth_type = 'guest'
    );

CREATE POLICY users_update_own ON users 
    FOR UPDATE USING (
        supabase_id = current_setting('app.current_user_id', true)::text
    );

-- Screening sessions policies
CREATE POLICY sessions_select_own ON screening_sessions 
    FOR SELECT USING (
        user_id IN (
            SELECT id FROM users 
            WHERE supabase_id = current_setting('app.current_user_id', true)::text
        )
    );

CREATE POLICY sessions_insert_own ON screening_sessions 
    FOR INSERT WITH CHECK (
        user_id IN (
            SELECT id FROM users 
            WHERE supabase_id = current_setting('app.current_user_id', true)::text
        )
    );

-- Audit logs policies (users can only see their own)
CREATE POLICY audit_select_own ON audit_logs 
    FOR SELECT USING (
        user_id IN (
            SELECT id FROM users 
            WHERE supabase_id = current_setting('app.current_user_id', true)::text
        )
    );
```

### 2. Enhanced User Model (Normalized)

```python
class User(db.Model):
    """Normalized user model with privacy controls"""
    __tablename__ = 'users'
    
    id = db.Column(db.Integer, primary_key=True)
    supabase_id = db.Column(db.String(36), unique=True, nullable=True, index=True)
    auth_type = db.Column(db.String(20), default='guest', nullable=False)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    updated_at = db.Column(db.DateTime, default=db.func.current_timestamp(), 
                          onupdate=db.func.current_timestamp())
    
    # Privacy settings
    data_retention_days = db.Column(db.Integer, default=365)  # Auto-delete after 1 year
    analytics_consent = db.Column(db.Boolean, default=False)
    marketing_consent = db.Column(db.Boolean, default=False)
    
    # Relationships
    profile = db.relationship('UserProfile', backref='user', uselist=False, cascade='all, delete-orphan')
    screening_sessions = db.relationship('ScreeningSessions', backref='user', cascade='all, delete-orphan')
    audit_logs = db.relationship('AuditLog', backref='user', cascade='all, delete-orphan')

class UserProfile(db.Model):
    """Separate table for optional demographic data"""
    __tablename__ = 'user_profiles'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    name = db.Column(db.String(100))
    surname = db.Column(db.String(100))
    age_group = db.Column(db.String(50))
    gender = db.Column(db.String(50))
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    updated_at = db.Column(db.DateTime, default=db.func.current_timestamp(), 
                          onupdate=db.func.current_timestamp())

class AuditLog(db.Model):
    """Comprehensive audit logging"""
    __tablename__ = 'audit_logs'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    action = db.Column(db.String(50), nullable=False)
    table_name = db.Column(db.String(50), nullable=False)
    record_id = db.Column(db.String(50))
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())
    ip_address = db.Column(db.String(45))  # IPv6 compatible
    user_agent = db.Column(db.Text)
    details = db.Column(db.JSON)
```

### 3. Data Control Panel API Endpoints

```python
# Privacy Control APIs
@app.route('/api/privacy/data-overview', methods=['GET'])
@require_auth
def get_data_overview():
    """Get complete overview of user's stored data"""
    
@app.route('/api/privacy/export-data', methods=['POST'])
@require_auth  
def request_data_export():
    """Request data export in CSV/JSON format"""
    
@app.route('/api/privacy/delete-data', methods=['POST'])
@require_auth
def request_data_deletion():
    """Initiate data deletion with confirmation process"""
    
@app.route('/api/privacy/confirm-deletion/<token>', methods=['POST'])
@require_auth
def confirm_data_deletion(token):
    """Confirm data deletion after verification"""
    
@app.route('/api/privacy/cancel-deletion/<token>', methods=['POST'])
@require_auth
def cancel_data_deletion(token):
    """Cancel pending data deletion during grace period"""
    
@app.route('/api/privacy/audit-log', methods=['GET'])
@require_auth
def get_audit_log():
    """Get user's audit log with pagination"""
```

## Data Models

### Normalized Database Schema

```sql
-- Core user identity (minimal data)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    supabase_id VARCHAR(36) UNIQUE,
    auth_type VARCHAR(20) DEFAULT 'guest',
    data_retention_days INTEGER DEFAULT 365,
    analytics_consent BOOLEAN DEFAULT FALSE,
    marketing_consent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Optional demographic data (separate table)
CREATE TABLE user_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100),
    surname VARCHAR(100),
    age_group VARCHAR(50),
    gender VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Existing screening_sessions table (already normalized)
-- No changes needed - already follows best practices

-- Data export tracking
CREATE TABLE data_export_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(20) NOT NULL,
    format VARCHAR(10) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    filters JSONB,
    file_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days')
);

-- Data deletion tracking with grace period
CREATE TABLE data_deletion_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deletion_type VARCHAR(20) NOT NULL,
    confirmation_token VARCHAR(64) NOT NULL UNIQUE,
    confirmation_phrase VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending',
    grace_period_ends TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    completed_at TIMESTAMP,
    details JSONB
);

-- Comprehensive audit logging
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(50) NOT NULL,
    record_id VARCHAR(50),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT,
    details JSONB
);

-- Indexes for performance
CREATE INDEX idx_users_supabase_id ON users(supabase_id);
CREATE INDEX idx_screening_sessions_user_timestamp ON screening_sessions(user_id, timestamp DESC);
CREATE INDEX idx_audit_logs_user_timestamp ON audit_logs(user_id, timestamp DESC);
CREATE INDEX idx_export_requests_user_status ON data_export_requests(user_id, status);
CREATE INDEX idx_deletion_requests_user_status ON data_deletion_requests(user_id, status);
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: RLS Data Isolation
*For any* authenticated user and any database query, the system should only return data records that belong to that specific user, preventing cross-user data access even with direct SQL queries
**Validates: Requirements 1.1, 1.2, 4.4**

### Property 2: Guest Data Non-Persistence  
*For any* guest user session, no test results or personal data should ever be stored in the database, ensuring complete anonymity
**Validates: Requirements 2.1, 2.2, 2.3**

### Property 3: Data Export Completeness
*For any* user data export request, the generated file should contain all user data that exists in the system at the time of export, with no missing records
**Validates: Requirements 9.3, 9.4**

### Property 4: Deletion Confirmation Round Trip
*For any* data deletion request, the confirmation process should require explicit user verification before any data is permanently removed
**Validates: Requirements 10.1, 10.2, 10.3**

### Property 5: Audit Log Integrity
*For any* data access or modification operation, an audit log entry should be created with complete context information and proper user attribution
**Validates: Requirements 5.1, 5.2, 5.3**

### Property 6: Backward Compatibility Preservation
*For any* system update or schema change, existing user data and functionality should remain accessible and operational without requiring user intervention
**Validates: Requirements 13.1, 13.2, 13.3**

### Property 7: Lightweight Resource Usage
*For any* deployment configuration, the system should operate within defined resource limits and maintain predictable performance characteristics
**Validates: Requirements 15.1, 15.2, 15.3**

## Error Handling

### Privacy-Specific Error Handling

```python
class PrivacyError(Exception):
    """Base class for privacy-related errors"""
    pass

class UnauthorizedDataAccess(PrivacyError):
    """Raised when user attempts to access data they don't own"""
    pass

class DataRetentionViolation(PrivacyError):
    """Raised when data retention policies are violated"""
    pass

class ExportGenerationError(PrivacyError):
    """Raised when data export fails"""
    pass

# Error handling middleware
@app.errorhandler(UnauthorizedDataAccess)
def handle_unauthorized_access(error):
    audit_log_security_event('unauthorized_access_attempt', str(error))
    return jsonify({'error': 'Access denied'}), 403

@app.errorhandler(DataRetentionViolation)
def handle_retention_violation(error):
    audit_log_security_event('retention_violation', str(error))
    return jsonify({'error': 'Data retention policy violation'}), 400
```

### Graceful Degradation

1. **RLS Policy Failures**: Fall back to application-level filtering with alerts
2. **Export Generation Failures**: Queue for retry with user notification
3. **Audit Log Failures**: Continue operation but alert administrators
4. **Authentication Failures**: Graceful fallback to guest mode

## Testing Strategy

### Unit Testing Approach

- **RLS Policy Testing**: Verify policies prevent cross-user access
- **Data Export Testing**: Validate completeness and format correctness
- **Confirmation Flow Testing**: Test multi-step verification processes
- **Audit Logging Testing**: Ensure all operations are properly logged

### Property-Based Testing Requirements

The testing framework will use **Hypothesis** for Python property-based testing with a minimum of 100 iterations per property test.

Each property-based test will be tagged with comments referencing the design document:
- Format: `**Feature: privacy-controls, Property {number}: {property_text}**`
- Each correctness property will be implemented by a single property-based test
- Tests will generate random user data, session data, and access patterns
- Properties will be verified across all generated test cases

### Integration Testing

- **End-to-End Privacy Flows**: Complete user data lifecycle testing
- **RLS Integration**: Database-level security verification
- **Export/Import Round-Trip**: Data integrity across export/import cycles
- **Multi-User Isolation**: Concurrent user access pattern testing

### Security Testing

- **SQL Injection Prevention**: Parameterized query validation
- **Cross-User Data Access**: Attempt unauthorized access patterns
- **Session Security**: Token validation and expiration testing
- **Audit Trail Integrity**: Tamper detection and completeness verification

## Implementation Phases

### Phase 1: Database Security Foundation
1. Implement RLS policies on existing tables
2. Create audit logging infrastructure
3. Add user context setting for database connections
4. Test RLS policy effectiveness

### Phase 2: Data Control Panel Backend
1. Create normalized user profile model
2. Implement data export APIs
3. Build data deletion workflow with confirmation
4. Add comprehensive audit logging

### Phase 3: User Interface Components
1. Design data control panel UI
2. Implement export request interface
3. Build deletion confirmation flows
4. Add audit log viewer

### Phase 4: Future Expansion Preparation
1. Implement extensible configuration system
2. Add plugin architecture for new test types
3. Create API versioning framework
4. Optimize for horizontal scaling

This design ensures comprehensive privacy controls while maintaining the lightweight, cost-effective architecture that makes AuroHear accessible and maintainable.