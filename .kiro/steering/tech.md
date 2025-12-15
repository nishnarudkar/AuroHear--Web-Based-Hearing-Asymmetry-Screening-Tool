# Technology Stack

## Backend
- **Framework**: Flask (Python 3.10+)
- **Database**: SQLAlchemy with PostgreSQL (Supabase) / SQLite fallback
- **Authentication**: Supabase Auth with local user sync
- **Audio Processing**: NumPy + SciPy for real-time tone generation
- **Deployment**: Gunicorn WSGI server, Docker containerized

## Frontend
- **Core**: Vanilla JavaScript (ES6+), HTML5, CSS3
- **Charts**: Chart.js for audiogram visualization
- **Authentication**: Supabase JavaScript client
- **Export**: jsPDF for report generation
- **Audio**: Web Audio API with server-generated WAV files

## Dependencies
### Python (requirements.txt)
```
Flask, Flask-SQLAlchemy, psycopg2-binary, gunicorn
python-dotenv, numpy, scipy, supabase
```

### JavaScript (package.json)
```
@supabase/supabase-js
```

## Common Commands

### Development
```bash
# Setup virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
source venv/bin/activate  # Unix

# Install dependencies
pip install -r requirements.txt
npm install

# Run development server
python app.py
# or
flask run --debug

# Create database tables
flask create-db
```

### Production Deployment
```bash
# Docker build
docker build -t aurohear .

# Run with Gunicorn
gunicorn app:app --bind 0.0.0.0:10000

# Environment variables required
DATABASE_URL, SUPABASE_URL, SUPABASE_KEY
```

## Architecture Notes
- **Audio Channel Handling**: Server-side WAV generation with channel swapping compensation
- **Database Migration**: Automatic SQLite schema updates for development
- **Error Handling**: Comprehensive timeout and fallback mechanisms for audio playback
- **State Management**: Server-side test state persistence in JSON format