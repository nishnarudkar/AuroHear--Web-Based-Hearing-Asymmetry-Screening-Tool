# Project Structure

## Root Directory
```
audiometry-test/
├── app.py                 # Main Flask application
├── requirements.txt       # Python dependencies
├── package.json          # Node.js dependencies
├── Dockerfile            # Container configuration
├── procfile              # Heroku/Render deployment
├── .env                  # Environment variables (not in git)
├── .gitignore           # Git ignore rules
└── README.md            # Project documentation
```

## Application Structure

### Backend (`app.py`)
- **Configuration**: Database URL handling, Supabase client setup
- **Models**: `User` class with SQLAlchemy ORM
- **Routes**: 
  - `/` - Main application page
  - `/register` - User registration/authentication sync
  - `/start_test` - Initialize hearing test
  - `/submit_response` - Process test responses
  - `/next_test` - Get next test parameters
  - `/tone` - Generate audio tones
- **Utilities**: Threshold computation, database migrations

### Frontend Structure
```
static/
├── styles.css           # Main application styles
├── auth_styles.css      # Authentication-specific styles
└── script.js           # Application JavaScript

templates/
└── index.html          # Single-page application template
```

### Database
```
instance/
└── users.db            # SQLite database (development)

users.db                # Alternative SQLite location
```

## Code Organization Patterns

### JavaScript Architecture
- **Screen Management**: Single-page app with screen switching
- **State Management**: Global variables for user session and test state
- **Audio Handling**: Server-generated tones with client-side playback
- **Error Handling**: Comprehensive try-catch with user feedback

### Python Architecture
- **Route Handlers**: RESTful API endpoints returning JSON
- **Database Layer**: SQLAlchemy models with automatic migrations
- **Audio Processing**: NumPy/SciPy for real-time WAV generation
- **Configuration**: Environment-based settings with fallbacks

### Styling Approach
- **CSS Architecture**: Component-based styling with utility classes
- **Responsive Design**: Mobile-first approach with glass morphism effects
- **Theme**: Professional medical interface with blue/red color coding for ears

## File Naming Conventions
- **Python**: Snake_case for functions, PascalCase for classes
- **JavaScript**: camelCase for variables/functions
- **CSS**: Kebab-case for class names
- **Routes**: Lowercase with underscores