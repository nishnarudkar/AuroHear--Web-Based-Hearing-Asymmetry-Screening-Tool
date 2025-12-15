# AuroHear - Hearing Asymmetry Screening Tool

A professional web-based audiometric screening application that detects potential hearing differences between ears using adaptive threshold testing.

## 🎯 Overview

AuroHear provides preliminary audiometric testing at standard frequencies (250-5000 Hz) to identify significant interaural differences (≥20 dB) that may indicate unilateral hearing loss. This is a **screening tool only** - not a diagnostic instrument.

## ✨ Features

- **Automated Audiometry**: Adaptive threshold testing with professional algorithms
- **Real-time Audio Generation**: Server-side WAV generation with precise channel control
- **Interactive Audiogram**: Chart.js visualization with downloadable reports (PNG/PDF)
- **Supabase Authentication**: Secure user management with guest mode fallback
- **Cross-browser Compatibility**: Robust audio playback with fallback mechanisms
- **Professional Reporting**: Clinical-style reports with patient demographics

## 🚀 Quick Start

### Prerequisites
- Python 3.10+
- Node.js (for frontend dependencies)
- Supabase account (for authentication and database)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd audiometry-test
   ```

2. **Set up Python environment**
   ```bash
   python -m venv venv
   venv\Scripts\activate  # Windows
   # source venv/bin/activate  # Unix/Mac
   pip install -r requirements.txt
   ```

3. **Install frontend dependencies**
   ```bash
   npm install
   ```

4. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your Supabase credentials
   ```

5. **Initialize database**
   ```bash
   flask create-db
   # or
   python -c "from app import app, db; app.app_context().push(); db.create_all()"
   ```

6. **Run the application**
   ```bash
   python app.py
   # Visit http://127.0.0.1:5000
   ```

## 🔧 Configuration

### Environment Variables
Create a `.env` file with:
```env
DATABASE_URL="postgresql://username:password@host:port/database"
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-anon-key"
```

### Supabase Setup
1. Create a new Supabase project
2. Get your project URL and anon key from Settings > API
3. Configure authentication providers as needed
4. The app will automatically create required database tables

## 🚢 Deployment

### Docker
```bash
docker build -t aurohear .
docker run -p 10000:10000 --env-file .env aurohear
```

### Platform Deployment (Render/Heroku)
1. Push code to Git (without `.env` file)
2. Set environment variables in platform dashboard
3. Deploy using provided `Dockerfile` or `Procfile`

## 🏗️ Architecture

### Backend (Flask)
- **Framework**: Flask with SQLAlchemy ORM
- **Database**: PostgreSQL (Supabase) with SQLite fallback
- **Audio Processing**: NumPy + SciPy for real-time tone generation
- **Authentication**: Supabase Auth with local user sync

### Frontend (Vanilla JS)
- **UI**: Single-page application with screen-based navigation
- **Charts**: Chart.js for audiogram visualization
- **Audio**: Web Audio API with server-generated WAV files
- **Export**: jsPDF for report generation

### Key Components
- **Adaptive Testing**: Professional audiometric algorithms
- **Channel Management**: Precise left/right ear audio routing
- **State Persistence**: Server-side test state in JSON format
- **Error Handling**: Comprehensive timeout and fallback mechanisms

## 📊 Usage

1. **Authentication**: Sign up/in with Supabase or use guest mode
2. **Device Check**: Verify headphone channels and audio routing
3. **Calibration**: Set comfortable listening volume
4. **Testing**: Automated threshold detection across frequencies
5. **Results**: View audiogram and download professional reports

## ⚠️ Important Disclaimers

- This is a **screening tool only** - not a diagnostic instrument
- Results require professional audiological interpretation
- Not suitable for clinical diagnosis or treatment decisions
- Consult a licensed audiologist for hearing concerns

## 🛠️ Development

### Project Structure
```
audiometry-test/
├── app.py              # Main Flask application
├── static/             # CSS, JS, and assets
├── templates/          # HTML templates
├── requirements.txt    # Python dependencies
├── Dockerfile         # Container configuration
└── .env.example       # Environment template
```

### Common Commands
```bash
# Development server
python app.py

# Database operations
flask create-db

# Docker build
docker build -t aurohear .

# Production server
gunicorn app:app --bind 0.0.0.0:$PORT
```

## 📄 License

See LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

**Note**: This application is for educational and screening purposes only. Always consult healthcare professionals for medical advice.