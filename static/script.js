// script.js - Enhanced authentication and user management
let currentScreen = 'login';
const testFrequencies = [5000, 4000, 2000, 1000, 500, 250];
let userId = null;
let calibrationVolume = 0.2; // Reduced default calibration volume for better control
const debugMode = true;

// Catch trial system for response reliability
let catchTrialData = {
    totalCatchTrials: 0,
    correctCatchResponses: 0, // Should respond "No" to catch trials
    trialsSinceLastCatch: 0,
    isCurrentTrialCatch: false,
    reliabilityScore: null
};

// Enhanced user state management
let currentUser = {
    id: null,
    name: '',
    surname: '',
    gender: '',
    ageGroup: '',
    authType: 'guest', // 'authenticated' or 'guest'
    supabaseId: null,
    isAuthenticated: false
};

// Legacy variables for backward compatibility
let userName = '';
let userSurname = '';
let userGender = '';
let userAgeGroup = '';

function logDebug(message) {
    if (debugMode) console.log(`[DEBUG] ${message}`);
}

/* -----------------------
   Small utility: fetch with timeout (cross-browser)
   ----------------------- */
function fetchWithTimeout(resource, options = {}) {
    const { timeout = 7000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(resource, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(id));
}

/* -----------------------
   Authentication State Management
   ----------------------- */
function updateUserState(userData) {
    if (userData) {
        currentUser.id = userData.id;
        currentUser.name = userData.name || '';
        currentUser.surname = userData.surname || '';
        currentUser.gender = userData.gender || '';
        currentUser.ageGroup = userData.age_group || '';
        currentUser.authType = userData.auth_type || 'guest';
        currentUser.supabaseId = userData.supabase_id;
        currentUser.isAuthenticated = userData.auth_type === 'authenticated';
        
        // Update legacy variables for backward compatibility
        userId = userData.id;
        userName = userData.name || '';
        userSurname = userData.surname || '';
        userGender = userData.gender || '';
        userAgeGroup = userData.age_group || '';
        
        logDebug(`User state updated: ${currentUser.authType} user ${currentUser.id}`);
    }
}

async function checkAuthenticationStatus() {
    try {
        // Check if user is authenticated with Supabase
        if (supabaseClient) {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session?.user) {
                logDebug('Supabase session found, checking backend sync');
                const response = await fetchWithTimeout(`/auth/status?supabase_id=${session.user.id}`, {
                    timeout: 5000
                });
                
                if (response.ok) {
                    const result = await response.json();
                    if (result.authenticated && result.user) {
                        updateUserState(result.user);
                        return true;
                    }
                }
            }
        }
        
        // No authentication found
        currentUser.isAuthenticated = false;
        currentUser.authType = 'guest';
        logDebug('No authentication found - guest mode');
        return false;
    } catch (error) {
        console.error('Auth status check failed:', error);
        return false;
    }
}

function updateUIForAuthState() {
    const isAuthenticated = currentUser.isAuthenticated;
    
    // Update welcome screen based on auth state
    const welcomeTitle = document.querySelector('#welcome-screen .title');
    if (welcomeTitle) {
        if (isAuthenticated && currentUser.name) {
            welcomeTitle.textContent = `Welcome back, ${currentUser.name}!`;
        } else {
            welcomeTitle.textContent = 'Welcome to AuroHear';
        }
    }
    
    // Show/hide auth-only elements
    const authElements = document.querySelectorAll('.auth-only');
    authElements.forEach(el => {
        el.style.display = isAuthenticated ? 'block' : 'none';
    });
    
    // Show/hide guest-only elements
    const guestElements = document.querySelectorAll('.guest-only');
    guestElements.forEach(el => {
        el.style.display = isAuthenticated ? 'none' : 'block';
    });
    
    // Update profile information if authenticated
    if (isAuthenticated) {
        const profileName = document.getElementById('profile-name');
        const profileDetails = document.getElementById('profile-details');
        
        if (profileName) {
            profileName.textContent = `${currentUser.name || 'User'} ${currentUser.surname || ''}`.trim();
        }
        
        if (profileDetails) {
            const details = [];
            if (currentUser.ageGroup) details.push(`Age: ${currentUser.ageGroup}`);
            if (currentUser.gender) details.push(`Gender: ${currentUser.gender}`);
            profileDetails.textContent = details.join(' • ') || 'Complete your profile';
        }
        
        // Collapse onboarding assistant for authenticated users to show profile better
        const assistant = document.getElementById('onboarding-assistant');
        const toggleBtn = document.getElementById('toggle-assistant');
        const content = document.getElementById('assistant-content');
        
        if (assistant && toggleBtn && content) {
            content.style.display = 'none';
            toggleBtn.textContent = 'Show Guide';
            assistant.classList.add('collapsed');
        }
    }
    
    logDebug(`UI updated for ${isAuthenticated ? 'authenticated' : 'guest'} user`);
}

/* -----------------------
   UI helpers
   ----------------------- */
function showScreen(screenId) {
    const scrollableScreens = ['testing', 'results', 'history']; // screens that should scroll
    document.querySelectorAll('#main-frame > section').forEach(sec => sec.classList.add('hidden'));
    const el = document.getElementById(screenId + '-screen') || document.getElementById(screenId);
    if (el) el.classList.remove('hidden');
    currentScreen = screenId;
    logDebug(`Switched to screen: ${screenId}`);

    // handle scrolling
    const mainFrame = document.getElementById('main-frame');
    if (!mainFrame) return;
    if (scrollableScreens.includes(screenId)) {
        mainFrame.classList.add('scrollable');
    } else {
        mainFrame.classList.remove('scrollable');
    }
}


function toggleLoader(show) {
    const ov = document.getElementById('loader-overlay');
    if (!ov) return;
    ov.classList.toggle('hidden', !show);
}

/* Set ear active visuals */
function setActiveEar(ear) {
    const left = document.getElementById('left-ear-icon');
    const right = document.getElementById('right-ear-icon');
    if (!left || !right) return;
    if (ear === 'left') {
        left.classList.add('ear-active'); left.classList.remove('ear-inactive');
        right.classList.add('ear-inactive'); right.classList.remove('ear-active');
    } else if (ear === 'right') {
        right.classList.add('ear-active'); right.classList.remove('ear-inactive');
        left.classList.add('ear-inactive'); left.classList.remove('ear-active');
    } else {
        left.classList.add('ear-inactive'); left.classList.remove('ear-active');
        right.classList.add('ear-inactive'); right.classList.remove('ear-active');
    }
}

/* -----------------------
   Audio playback (server)
   ----------------------- */
// Audio context for Web Audio API fallback
let audioContext = null;
let audioInitialized = false;

// Initialize audio context (must be called after user interaction)
function initializeAudioContext() {
    if (audioInitialized) return Promise.resolve();
    
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioContext = new AudioContextClass();
            
            // Handle suspended context (common in production)
            if (audioContext.state === 'suspended') {
                logDebug('Audio context suspended, attempting to resume...');
                return audioContext.resume().then(() => {
                    audioInitialized = true;
                    logDebug('Audio context resumed and initialized successfully');
                }).catch(e => {
                    console.warn('Failed to resume audio context:', e);
                    audioInitialized = true; // Mark as initialized anyway
                    return Promise.resolve();
                });
            } else {
                audioInitialized = true;
                logDebug('Audio context initialized successfully');
                return Promise.resolve();
            }
        }
    } catch (e) {
        console.warn('Audio context initialization failed:', e);
    }
    return Promise.resolve(); // Continue without audio context
}

// Generate tone using Web Audio API (fallback method)
function generateWebAudioTone(freq, duration, volume, channel) {
    return new Promise((resolve) => {
        if (!audioContext) {
            console.warn('No audio context available for Web Audio API');
            resolve();
            return;
        }

        try {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            const merger = audioContext.createChannelMerger(2);
            
            oscillator.frequency.setValueAtTime(freq, audioContext.currentTime);
            oscillator.type = 'sine';
            
            // Set volume with fade in/out
            const now = audioContext.currentTime;
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(volume * 0.3, now + 0.01); // Fade in
            gainNode.gain.setValueAtTime(volume * 0.3, now + duration - 0.01);
            gainNode.gain.linearRampToValueAtTime(0, now + duration); // Fade out
            
            // Connect based on channel
            oscillator.connect(gainNode);
            if (channel === 'left') {
                gainNode.connect(merger, 0, 0);
            } else if (channel === 'right') {
                gainNode.connect(merger, 0, 1);
            } else {
                gainNode.connect(merger, 0, 0);
                gainNode.connect(merger, 0, 1);
            }
            merger.connect(audioContext.destination);
            
            oscillator.start(now);
            oscillator.stop(now + duration);
            
            oscillator.onended = () => {
                logDebug('Web Audio API tone ended');
                resolve();
            };
            
            setTimeout(() => resolve(), duration * 1000 + 100);
            
        } catch (e) {
            console.error('Web Audio API tone generation failed:', e);
            resolve();
        }
    });
}

function playServerTone(params) {
    // Initialize audio context on first use
    initializeAudioContext();
    
    const url = new URL('/tone', window.location);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v.toString()));
    logDebug(`Playing tone: ${JSON.stringify(params)}`);
    
    return new Promise((resolve) => {
        const audio = new Audio();
        let resolved = false;
        
        const resolveOnce = () => {
            if (!resolved) {
                resolved = true;
                resolve();
            }
        };
        
        // Enhanced Hughson-Westlake audiometric amplitude mapping with steeper attenuation
        const levelDb = params.level_db || 40;
        const REFERENCE_DB = 50; // Increased reference level for better dynamic range
        
        // Enforce silence at 0 dB and below
        if (levelDb <= 0) {
            audio.volume = 0.0;
            logDebug(`Volume calculation: ${levelDb}dB -> SILENT (≤ 0 dB HL)`);
        } else {
            // Calculate dB relative to 50 dB reference for steeper curve
            const effectiveDb = levelDb - REFERENCE_DB;
            
            // Enhanced logarithmic dB-to-gain conversion with additional attenuation
            const rawGain = Math.pow(10, effectiveDb / 20);
            
            // Apply additional attenuation factor for more gradual volume changes
            const attenuationFactor = 0.4; // Reduce overall amplitude significantly
            const adjustedGain = rawGain * attenuationFactor;
            
            // Clamp gain to much lower audiometric range [0.0001, 0.15]
            const clampedGain = Math.max(0.0001, Math.min(0.15, adjustedGain));
            
            // Apply calibration volume with additional safety reduction
            const safetyFactor = 0.7; // Additional safety reduction
            audio.volume = calibrationVolume * clampedGain * safetyFactor * (params.volume || 1);
            
            logDebug(`Volume calculation: ${levelDb}dB -> effective=${effectiveDb}dB, rawGain=${rawGain.toFixed(4)}, attenuated=${adjustedGain.toFixed(4)}, clampedGain=${clampedGain.toFixed(4)}, final=${audio.volume.toFixed(4)}`);
        }
        
        // Enhanced audio properties for better compatibility
        audio.preload = 'auto';
        audio.crossOrigin = 'anonymous';
        
        // Production-specific audio settings
        if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            audio.autoplay = false; // Disable autoplay in production
            audio.muted = false; // Ensure not muted
        }
        
        // Force audio format and add cache busting
        const urlWithCache = `${url.toString()}&t=${Date.now()}&prod=1`;
        
        logDebug(`Audio volume set to: ${audio.volume} (calibration: ${calibrationVolume})`);
        logDebug(`Audio URL: ${urlWithCache}`);
        
        // Set up event handlers
        audio.onended = () => {
            logDebug('Audio playback ended normally');
            resolveOnce();
        };
        
        audio.onerror = (e) => {
            console.error('Audio error:', e, audio.error);
            logDebug('Audio failed, trying Web Audio API fallback');
            
            // Show visual indicator for audio issues
            showAudioError('Audio playback failed. Trying alternative method...');
            
            // Log detailed error information for production debugging
            console.error('Audio Error Details:', {
                error: audio.error,
                networkState: audio.networkState,
                readyState: audio.readyState,
                src: audio.src,
                volume: audio.volume,
                muted: audio.muted,
                paused: audio.paused
            });
            
            // Try Web Audio API fallback
            if (audioContext && params.freq) {
                logDebug('Attempting Web Audio API fallback');
                generateWebAudioTone(
                    params.freq, 
                    params.duration || 0.35, 
                    audio.volume, 
                    params.channel || 'both'
                ).then(resolveOnce);
            } else {
                logDebug('No Web Audio API available, resolving without audio');
                showAudioError('Audio system unavailable. Please check your browser settings.');
                resolveOnce();
            }
        };
        
        audio.onloadstart = () => {
            logDebug('Audio loading started');
        };
        
        audio.oncanplay = () => {
            logDebug('Audio can play');
        };
        
        // Set up fallback timer
        const baseDuration = parseFloat(params.duration || 0.35) * 1000;
        const fallbackMs = baseDuration + (params.freq <= 500 ? 500 : 300);
        
        const fallback = setTimeout(() => {
            if (!resolved) {
                logDebug('Audio playback fallback triggered - trying Web Audio API');
                try { audio.pause(); } catch (e) { }
                
                // Try Web Audio API as final fallback
                if (audioContext && params.freq) {
                    generateWebAudioTone(
                        params.freq, 
                        params.duration || 0.35, 
                        audio.volume, 
                        params.channel || 'both'
                    ).then(resolveOnce);
                } else {
                    resolveOnce();
                }
            }
        }, fallbackMs + 500);

        // Set source and attempt to play
        audio.src = urlWithCache;
        
        audio.play().then(() => {
            logDebug('Audio playback started successfully');
        }).catch(err => {
            console.error('Audio playback error:', err);
            clearTimeout(fallback);
            
            // Log detailed playback error for production debugging
            console.error('Audio Play Error Details:', {
                name: err.name,
                message: err.message,
                code: err.code,
                audioSrc: audio.src,
                audioVolume: audio.volume,
                audioMuted: audio.muted,
                userAgent: navigator.userAgent,
                isSecureContext: window.isSecureContext,
                protocol: window.location.protocol
            });
            
            // Show user-friendly error message
            showAudioError('Audio playback blocked. Please ensure audio is enabled in your browser.');
            
            // Immediate Web Audio API fallback
            if (audioContext && params.freq) {
                logDebug('Trying immediate Web Audio API fallback due to play() failure');
                generateWebAudioTone(
                    params.freq, 
                    params.duration || 0.35, 
                    audio.volume, 
                    params.channel || 'both'
                ).then(resolveOnce);
            } else {
                logDebug('No Web Audio API available for fallback');
                setTimeout(resolveOnce, fallbackMs);
            }
        });
    });
}

async function playTestTone(freq, channel, levelDb) {
    // Let server handle all dB-to-amplitude conversion for accurate audiometric testing
    const duration = 0.35;
    setActiveEar(channel);
    
    // Pass dB level to server for proper audiometric volume calculation
    await playServerTone({ 
        freq: freq, 
        duration: duration, 
        volume: 1.0,  // Use full scale, let server handle dB conversion
        channel: channel,
        level_db: levelDb
    });
    
    const earEl = channel === 'left' ? document.getElementById('left-ear-icon') : document.getElementById('right-ear-icon');
    if (earEl) {
        earEl.animate([{ transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
    }
}

/* Channel test button (device check) */
function playChannelTest(channel) {
    const status = document.getElementById('channel-status');
    if (status) {
        status.textContent = `Playing in ${channel.toUpperCase()} ear — listen...`;
        status.style.color = channel === 'left' ? '#3b2f2f' : '#7a5a4a';
    }
    
    // Initialize audio context on user interaction
    initializeAudioContext();
    
    setActiveEar(channel);
    
    // Enhanced channel test with controlled volume for better audibility
    playServerTone({ 
        freq: 1000, 
        duration: 1.0,  // Longer duration for better testing
        volume: 1.0,    // Use full scale, let dB system handle volume
        channel: channel,
        level_db: 55    // Moderate dB level for channel testing
    }).then(() => setTimeout(() => {
        if (status) status.textContent = '';
        setActiveEar(null);
    }, 500));
}

/* -----------------------
   Event listeners (wiring)
   ----------------------- */
/* -----------------------
   Supabase & Auth Logic
   ----------------------- */
let supabaseClient = null;
if (window.SUPABASE_URL && window.SUPABASE_KEY) {
    try {
        supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
        logDebug('Supabase client initialized');
    } catch (e) {
        console.error('Supabase init error (check CDN/Keys):', e);
    }
} else {
    console.warn('Supabase URL/Key missing.');
}

let isSignUp = false; // default mode: Sign In

document.addEventListener('DOMContentLoaded', async () => {
    console.log('JavaScript is loading...');
    console.log('Supabase URL:', window.SUPABASE_URL);
    console.log('Supabase available:', !!window.supabase);
    
    // Check authentication status on app load
    const isAuthenticated = await checkAuthenticationStatus();
    updateUIForAuthState();
    
    // Run audio system diagnostics in production
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        setTimeout(() => {
            runAudioDiagnostics();
        }, 2000);
    }
    
    // If authenticated, skip login and go to welcome
    if (isAuthenticated) {
        showScreen('welcome');
    }
    
    // Auth Toggles
    const toggleSignIn = document.getElementById('toggle-signin');
    const toggleSignUp = document.getElementById('toggle-signup');
    const signupFields = document.getElementById('signup-fields');
    const submitBtn = document.getElementById('auth-submit-btn');

    if (toggleSignIn && toggleSignUp) {
        toggleSignIn.addEventListener('click', () => {
            isSignUp = false;
            toggleSignIn.classList.add('active');
            toggleSignUp.classList.remove('active');
            signupFields.classList.add('hidden');
            submitBtn.textContent = 'Sign In';
            document.getElementById('auth-error').classList.add('hidden');
        });

        toggleSignUp.addEventListener('click', () => {
            isSignUp = true;
            toggleSignIn.classList.remove('active');
            toggleSignUp.classList.add('active');
            signupFields.classList.remove('hidden');
            submitBtn.textContent = 'Sign Up';
            document.getElementById('auth-error').classList.add('hidden');
        });
    }

    // Auth Form
    const authForm = document.getElementById('auth-form');
    console.log('Auth form found:', !!authForm);
    if (authForm) authForm.addEventListener('submit', onAuthSubmit);

    // Guest Bypass
    const bypassBtn = document.getElementById('bypass-btn');
    console.log('Bypass button found:', !!bypassBtn);
    if (bypassBtn) bypassBtn.addEventListener('click', () => {
        console.log('Guest button clicked!');
        // Simple guest flow: just ask for name in a prompt or simplified mode
        // For now, let's just use a default guest user or switch UI to old form?
        // Easiest: Pre-fill a guest email/pass or just use the local register.
        // Let's just create a local guest user directly without Supabase.
        createGuestUser();
    });

    // ... (rest of listeners)
    const demoBtn = document.getElementById('demo-btn'); // may be gone now

    // ... Existing wiring
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.addEventListener('click', () => {
        // Professional interface - no popup tips needed
        showScreen('consent');
    });

    const agreeBtn = document.getElementById('agree-btn');
    if (agreeBtn) agreeBtn.addEventListener('click', () => showScreen('device-check'));

    const backWelcomeBtn = document.getElementById('back-welcome-btn');
    if (backWelcomeBtn) backWelcomeBtn.addEventListener('click', () => showScreen('welcome'));

    const leftBtn = document.getElementById('left-ear-btn');
    if (leftBtn) leftBtn.addEventListener('click', () => playChannelTest('left'));
    const rightBtn = document.getElementById('right-ear-btn');
    if (rightBtn) rightBtn.addEventListener('click', () => playChannelTest('right'));

    const headphonesReady = document.getElementById('headphones-ready-btn');
    if (headphonesReady) headphonesReady.addEventListener('click', () => showScreen('calibration'));
    const backConsentBtn = document.getElementById('back-consent-btn');
    if (backConsentBtn) backConsentBtn.addEventListener('click', () => showScreen('consent'));

    const playToneBtn = document.getElementById('play-tone-btn');
    if (playToneBtn) playToneBtn.addEventListener('click', () => {
        // Professional calibration - controlled for audiometric accuracy
        playServerTone({ 
            freq: 1000, 
            duration: 1.0, 
            volume: 1.0, 
            channel: 'both',
            level_db: 45  // Moderate dB level for calibration tone
        });
    });

    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) volumeSlider.addEventListener('input', (e) => {
        calibrationVolume = parseFloat(e.target.value);
        logDebug(`Volume set to: ${calibrationVolume}`);
    });

    const volumeSetBtn = document.getElementById('volume-set-btn');
    if (volumeSetBtn) volumeSetBtn.addEventListener('click', () => showScreen('instructions'));

    const backDeviceBtn = document.getElementById('back-device-btn');
    if (backDeviceBtn) backDeviceBtn.addEventListener('click', () => showScreen('device-check'));

    const startTestBtn = document.getElementById('start-test-btn');
    if (startTestBtn) startTestBtn.addEventListener('click', startHearingTest);

    const backCalibrationBtn = document.getElementById('back-calibration-btn');
    if (backCalibrationBtn) backCalibrationBtn.addEventListener('click', () => showScreen('calibration'));

    const tryAgainBtn = document.getElementById('try-again-btn');
    if (tryAgainBtn) tryAgainBtn.addEventListener('click', restartTest);

    document.querySelectorAll('#exit-btn, #exit-test-early').forEach(b => {
        if (b) b.addEventListener('click', () => location.reload());
    });

    const downloadBtn = document.getElementById('download-results-btn');
    if (downloadBtn) downloadBtn.addEventListener('click', downloadResults);
    const downloadPdfBtn = document.getElementById('download-pdf-btn');
    if (downloadPdfBtn) downloadPdfBtn.addEventListener('click', downloadPDF);

    const yesBtn = document.getElementById('yes-btn');
    const noBtn = document.getElementById('no-btn');
    if (yesBtn) yesBtn.addEventListener('click', () => submitResponse(true));
    if (noBtn) noBtn.addEventListener('click', () => submitResponse(false));

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (confirm('Sure you want to exit?')) showScreen('welcome');
        } else if (event.key === ' ' && (currentScreen === 'welcome')) {
            showScreen('consent');
        }
    });

    // Profile management event listeners
    const editProfileBtn = document.getElementById('edit-profile-btn');
    if (editProfileBtn) editProfileBtn.addEventListener('click', showProfileScreen);
    
    const viewHistoryBtn = document.getElementById('view-history-btn');
    if (viewHistoryBtn) viewHistoryBtn.addEventListener('click', showHistoryScreen);
    
    const profileForm = document.getElementById('profile-form');
    if (profileForm) profileForm.addEventListener('submit', saveProfile);
    
    const cancelProfileBtn = document.getElementById('cancel-profile-btn');
    if (cancelProfileBtn) cancelProfileBtn.addEventListener('click', () => showScreen('welcome'));
    
    const backToWelcomeBtn = document.getElementById('back-to-welcome-btn');
    if (backToWelcomeBtn) backToWelcomeBtn.addEventListener('click', () => showScreen('welcome'));

    // History tab navigation
    const tabList = document.getElementById('tab-list');
    const tabAudiogram = document.getElementById('tab-audiogram');
    if (tabList) tabList.addEventListener('click', () => switchHistoryTab('list'));
    if (tabAudiogram) tabAudiogram.addEventListener('click', () => switchHistoryTab('audiogram'));

    // Audiogram controls
    const selectAllBtn = document.getElementById('select-all-sessions');
    const clearAllBtn = document.getElementById('clear-all-sessions');
    const showLatest5Btn = document.getElementById('show-latest-5');
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => toggleAllSessions(true));
    if (clearAllBtn) clearAllBtn.addEventListener('click', () => toggleAllSessions(false));
    if (showLatest5Btn) showLatest5Btn.addEventListener('click', showLatest5Sessions);

    // Onboarding assistant
    initializeOnboardingAssistant();
    
    // Test guidance system
    initializeTestGuidance();

    setActiveEar(null);
});

async function onAuthSubmit(e) {
    console.log('Auth form submitted!');
    e.preventDefault();
    if (!supabaseClient) {
        console.error('Supabase not available');
        showError('Supabase not configured correctly.');
        return;
    }

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');
    toggleLoader(true);

    try {
        let authUser = null;
        if (isSignUp) {
            // REGISTER
            const { data, error } = await supabaseClient.auth.signUp({
                email: email,
                password: password,
            });
            if (error) throw error;
            authUser = data.user;
            if (data.session) {
                // Determine demographic data
                userName = document.getElementById('name')?.value || 'User';
                userSurname = document.getElementById('surname')?.value || '';
                userAgeGroup = document.querySelector('input[name="age_group"]:checked')?.value || 'adult';
                userGender = document.querySelector('input[name="gender"]:checked')?.value || 'prefer_not_to_say';

                // Sync with backend
                await syncBackendUser(authUser.id, userName, userSurname, userAgeGroup, userGender);
            } else {
                // Confirmation email sent case?
                alert('Please check your email to confirm sign up!');
                toggleLoader(false);
                return;
            }
        } else {
            // SIGN IN
            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: email,
                password: password,
            });
            if (error) throw error;
            authUser = data.user;

            // Sync/Fetch backend user
            // We'll pass nulls for demographics to keep existing if present
            await syncBackendUser(authUser.id, null, null, null, null);
        }

    } catch (err) {
        console.error('Auth error:', err);
        showError(err.message || 'Authentication failed');
        toggleLoader(false);
    }
}

async function syncBackendUser(supabaseId, name, surname, age, gender) {
    try {
        const payload = {
            supabase_id: supabaseId
        };
        // Only add if provided (update usage)
        if (name) payload.name = name;
        if (surname) payload.surname = surname;
        if (age) payload.age_group = age;
        if (gender) payload.gender = gender;

        const response = await fetchWithTimeout('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeout: 8000
        });

        if (!response.ok) throw new Error('Backend sync failed');
        const result = await response.json();
        
        // Update enhanced user state
        if (result.user_data) {
            updateUserState(result.user_data);
        }
        
        // Update legacy variables for backward compatibility
        userId = result.user_id;
        if (result.user_data) {
            userName = result.user_data.name || '';
            userSurname = result.user_data.surname || '';
            userAgeGroup = result.user_data.age_group || '';
            userGender = result.user_data.gender || '';
        }

        logDebug(`User synced: SupabaseID=${supabaseId} -> LocalID=${userId} Type=${result.auth_type}`);
        updateUIForAuthState();
        toggleLoader(false);
        showScreen('welcome');
    } catch (err) {
        console.error('Backend sync error:', err);
        showError('Database connection failed.');
        toggleLoader(false);
    }
}

async function createGuestUser() {
    const guestName = prompt("Enter a guest name:", "Guest");
    if (!guestName) return;

    toggleLoader(true);
    try {
        const response = await fetchWithTimeout('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: guestName, 
                surname: '', 
                age_group: 'adult',
                gender: 'prefer_not_to_say'
            }), // No Supabase ID = guest user
            timeout: 6000
        });
        
        if (!response.ok) throw new Error('Guest registration failed');
        const result = await response.json();
        
        // Update enhanced user state
        if (result.user_data) {
            updateUserState(result.user_data);
        }
        
        // Update legacy variables
        userId = result.user_id;
        userName = guestName;
        userSurname = '';
        userAgeGroup = 'adult';
        userGender = 'prefer_not_to_say';
        
        logDebug(`Guest user created: ID=${userId}`);
        updateUIForAuthState();
        toggleLoader(false);
        showScreen('welcome');
    } catch (e) {
        console.error('Guest creation error:', e);
        toggleLoader(false);
        alert("Guest login failed. Please try again.");
    }
}

function showError(msg) {
    const el = document.getElementById('auth-error');
    if (el) {
        el.textContent = msg;
        el.classList.remove('hidden');
    }
}

/* -----------------------
   (Original Registration removed)
   ----------------------- */

/* -----------------------
   Catch Trial System for Response Reliability
   ----------------------- */
function shouldInsertCatchTrial(testData) {
    // Never insert during threshold confirmation (ascending trials)
    if (testData.phase === 'threshold_confirmation' || testData.ascending_count >= 2) {
        return false;
    }
    
    // Never insert consecutive catch trials
    if (catchTrialData.trialsSinceLastCatch === 0) {
        return false;
    }
    
    // Insert randomly every 8-12 trials
    const minInterval = 8;
    const maxInterval = 12;
    const shouldInsert = catchTrialData.trialsSinceLastCatch >= minInterval && 
                        Math.random() < (1 / (maxInterval - minInterval + 1));
    
    logDebug(`Catch trial check: trials since last=${catchTrialData.trialsSinceLastCatch}, should insert=${shouldInsert}`);
    return shouldInsert;
}

function processCatchTrialResponse(heard) {
    if (!catchTrialData.isCurrentTrialCatch) return;
    
    catchTrialData.totalCatchTrials++;
    
    // Correct response to catch trial is "No" (didn't hear anything)
    if (!heard) {
        catchTrialData.correctCatchResponses++;
        logDebug('Catch trial: Correct response (No)');
    } else {
        logDebug('Catch trial: Incorrect response (Yes to silence)');
    }
    
    // Calculate reliability score
    if (catchTrialData.totalCatchTrials > 0) {
        catchTrialData.reliabilityScore = 
            (catchTrialData.correctCatchResponses / catchTrialData.totalCatchTrials) * 100;
    }
    
    logDebug(`Catch trial stats: ${catchTrialData.correctCatchResponses}/${catchTrialData.totalCatchTrials} correct (${catchTrialData.reliabilityScore?.toFixed(1)}%)`);
}

function getReliabilityIndicator() {
    if (catchTrialData.totalCatchTrials < 2) {
        return { level: 'insufficient', description: 'Insufficient data for reliability assessment' };
    }
    
    const score = catchTrialData.reliabilityScore;
    
    if (score >= 80) {
        return { level: 'high', description: 'High response reliability' };
    } else if (score >= 60) {
        return { level: 'medium', description: 'Medium response reliability' };
    } else {
        return { level: 'low', description: 'Low response reliability - consider retesting' };
    }
}

/* -----------------------
   Start test / run test
   ----------------------- */
async function startHearingTest() {
    if (!userId) {
        alert('User ID is missing. Please restart the test.');
        showScreen('login');
        return;
    }
    
    // Reset catch trial data for new test
    catchTrialData = {
        totalCatchTrials: 0,
        correctCatchResponses: 0,
        trialsSinceLastCatch: 0,
        isCurrentTrialCatch: false,
        reliabilityScore: null
    };
    
    logDebug('Catch trial system reset for new test');
    
    // Professional test start - no popup tips needed
    
    logDebug(`Starting test for user ID=${userId}`);
    showScreen('testing');
    
    // Initialize test guidance
    updateTestGuidance('starting', 'Initializing your hearing test...');
    
    toggleLoader(true);
    try {
        const response = await fetchWithTimeout('/start_test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
            timeout: 7000
        });
        if (!response.ok) throw new Error(`Start test failed: ${response.statusText}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        logDebug(`Test started: ${JSON.stringify(data)}`);
        toggleLoader(false);
        
        // Update guidance for first test
        updateTestGuidance('testing', 'Your hearing test is now beginning. Listen carefully!');
        
        await runTest(data);
    } catch (err) {
        toggleLoader(false);
        console.error('Start test error:', err);
        updateTestGuidance('preparing', 'Test failed to start. Please try again.');
        alert(`Failed to start test: ${err.message}. Please try again.`);
        showScreen('welcome');
    }
}

async function runTest(testData) {
    logDebug(`Running test: ${JSON.stringify(testData)}`);
    
    // Check if this should be a catch trial
    catchTrialData.trialsSinceLastCatch++;
    catchTrialData.isCurrentTrialCatch = shouldInsertCatchTrial(testData);
    
    if (catchTrialData.isCurrentTrialCatch) {
        catchTrialData.trialsSinceLastCatch = 0;
        logDebug('Inserting catch trial (silent presentation)');
    }
    
    // Update progress with enhanced display
    updateProgressWithPhases(testData.progress ?? 0, testData.test_number, testData.total_tests);
    
    // Update contextual guidance
    const isFirstTest = testData.test_number === 1;
    const isEarSwitch = testData.test_number > 1 && testData.test_number <= testData.total_tests / 2;
    
    let phase = 'threshold_finding';
    if (isFirstTest) phase = 'first_tone';
    else if (isEarSwitch) phase = 'ear_switching';
    
    updateTestGuidance('testing', `Testing ${testData.ear} ear at ${testData.freq} Hz`, {
        ear: testData.ear,
        frequency: testData.freq,
        level: testData.level ?? 40
    });
    
    updateInstructionText(phase, testData.ear, testData.freq);
    
    // Update ear status
    updateEarStatus('left', testData.ear === 'left' ? 'testing' : 'inactive');
    updateEarStatus('right', testData.ear === 'right' ? 'testing' : 'inactive');
    
    const currentEar = testData.ear;
    setActiveEar(currentEar);

    // Disable buttons and show tone indicator
    enableResponseButtons(false);
    
    if (catchTrialData.isCurrentTrialCatch) {
        // Catch trial: Show normal indicator but play no sound
        showToneIndicator(true, { frequency: testData.freq, level: 0, isCatchTrial: true });
        
        // Simulate normal tone duration with silence
        await new Promise(resolve => setTimeout(resolve, 350));
        
        // Finish "playing" the silent tone
        showToneIndicator(false);
        enableResponseButtons(true);
        
        logDebug('Catch trial (silence) presented, buttons enabled');
        return;
    } else {
        // Normal trial: Play actual tone
        showToneIndicator(true, { frequency: testData.freq, level: testData.level ?? 40 });

        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                await playTestTone(testData.freq, testData.ear, testData.level ?? 40);
                
                // Tone finished playing
                showToneIndicator(false);
                enableResponseButtons(true);
                
                logDebug('Tone played, buttons enabled');
                return;
            } catch (err) {
                attempts++;
                console.error(`Tone playback error (attempt ${attempts}):`, err);
                if (attempts === maxAttempts) {
                    console.error('Max playback attempts reached');
                    updateTestGuidance('testing', 'Audio error occurred. Please try again or check your headphones.');
                    showToneIndicator(false);
                    enableResponseButtons(true);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }
}

/* -----------------------
   Submit response and next test
   ----------------------- */
async function submitResponse(heard) {
    if (!userId) {
        alert('User ID is missing. Please restart the test.');
        showScreen('login');
        return;
    }

    logDebug(`Submitting response: heard=${heard}, isCatchTrial=${catchTrialData.isCurrentTrialCatch}`);
    
    // Process catch trial response (but don't reveal it to user)
    processCatchTrialResponse(heard);
    
    const responseStatus = document.getElementById('response-status');
    if (responseStatus) responseStatus.textContent = 'Submitting response...';
    const yesBtn = document.getElementById('yes-btn');
    const noBtn = document.getElementById('no-btn');
    if (yesBtn) yesBtn.disabled = true;
    if (noBtn) noBtn.disabled = true;

    toggleLoader(true);
    try {
        // Only submit to server if it's NOT a catch trial
        if (!catchTrialData.isCurrentTrialCatch) {
            const response = await fetchWithTimeout('/submit_response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, heard: heard }),
                timeout: 6000
            });
            if (!response.ok) throw new Error(`Submit response failed: ${response.statusText}`);
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            logDebug('Response submitted successfully');

            const nextTest = await fetchWithTimeout(`/next_test?user_id=${userId}`, { timeout: 6000 });
            if (!nextTest.ok) throw new Error(`Next test failed: ${nextTest.statusText}`);
            const testData = await nextTest.json();
            if (testData.error) throw new Error(testData.error);
            logDebug(`Next test data: ${JSON.stringify(testData)}`);

            toggleLoader(false);
            if (testData.completed) {
                logDebug('Test completed, showing results');
                updateTestGuidance('completed', 'Congratulations! Your hearing test is complete.');
                setTimeout(() => showResultsScreen(testData), 1000);
            } else {
                setTimeout(() => runTest(testData), 150);
            }
        } else {
            // Catch trial: Skip server submission, continue with same test parameters
            logDebug('Catch trial completed, continuing without server submission');
            
            // Get current test state to continue
            const nextTest = await fetchWithTimeout(`/next_test?user_id=${userId}`, { timeout: 6000 });
            if (!nextTest.ok) throw new Error(`Next test failed: ${nextTest.statusText}`);
            const testData = await nextTest.json();
            if (testData.error) throw new Error(testData.error);
            
            toggleLoader(false);
            if (testData.completed) {
                logDebug('Test completed, showing results');
                updateTestGuidance('completed', 'Congratulations! Your hearing test is complete.');
                setTimeout(() => showResultsScreen(testData), 1000);
            } else {
                setTimeout(() => runTest(testData), 150);
            }
        }
    } catch (err) {
        toggleLoader(false);
        console.error('Submit response error:', err);
        alert(`Error: ${err.message}. Please try again or restart the test.`);
        if (yesBtn) yesBtn.disabled = false;
        if (noBtn) noBtn.disabled = false;
        if (responseStatus) responseStatus.textContent = 'Error submitting response. Please try again.';
    }
}

/* -----------------------
   Download results (canvas)
   ----------------------- */
function generateReportCanvas() {
    const canvas = document.getElementById('audiogram-chart');
    const chart = window.__audiogramChart;
    if (!chart || !canvas) throw new Error('Chart not found');
    // Create a larger canvas for a structured report
    const padding = 32;
    const footerHeight = 96;
    const chartX = padding;
    const chartWidth = canvas.width;
    const chartHeight = canvas.height;

    // We'll initially allow a larger header to include disclaimer
    const headerHeightBase = 110;

    // add generous extra vertical space to avoid truncation
    const extraSpace = 300;
    const newCanvas = document.createElement('canvas');
    newCanvas.width = chartWidth + padding * 2;
    // make room: header + chart + extra + footer
    newCanvas.height = headerHeightBase + chartHeight + footerHeight + extraSpace;
    const ctx = newCanvas.getContext('2d');

    // helper: wrap text into lines
    function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
        const words = text.split(' ');
        let line = '';
        let lines = [];
        for (let i = 0; i < words.length; i++) {
            const testLine = line + words[i] + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && line !== '') {
                lines.push(line.trim());
                line = words[i] + ' ';
            } else {
                line = testLine;
            }
        }
        if (line.trim()) lines.push(line.trim());
        if (maxLines && lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            lines[lines.length - 1] = lines[lines.length - 1].slice(0, 80) + ' ...';
        }
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x, y + (i * lineHeight));
        }
        return y + (lines.length * lineHeight);
    }

    // background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, newCanvas.width, newCanvas.height);

    // Report header
    ctx.fillStyle = '#3b2f2f';
    ctx.font = '700 22px Inter, Arial';
    ctx.fillText('Hearing Screening Report', padding, 36);
    ctx.font = '500 12px Inter, Arial';
    ctx.fillStyle = '#6b5b4b';
    ctx.fillText('Automated screening tool — preliminary results', padding, 56);

    // Patient demographics box (positioned at top-right)
    const demoX = newCanvas.width - padding - 300;
    const demoY = padding;
    const demoHeight = 72;
    ctx.fillStyle = 'rgba(59,47,47,0.04)';
    ctx.fillRect(demoX, demoY, 300, demoHeight);
    ctx.strokeStyle = 'rgba(59,47,47,0.06)';
    ctx.strokeRect(demoX, demoY, 300, demoHeight);
    ctx.fillStyle = '#3b2f2f';
    ctx.font = '600 13px Inter, Arial';
    ctx.fillText(`Name: ${userName || '-'} ${userSurname || ''}`, demoX + 12, demoY + 24);
    ctx.font = '500 12px Inter, Arial';
    ctx.fillStyle = '#6b5b4b';
    ctx.fillText(`Gender: ${userGender || '-'}`, demoX + 12, demoY + 44);
    ctx.fillText(`Age group: ${userAgeGroup || '-'}`, demoX + 12, demoY + 60);

    // Draw disclaimer immediately under header and demographics area
    const disclaimer = 'Disclaimer: This screening tool provides preliminary results only and is not a diagnostic test. It does not replace assessment by a qualified audiologist or physician. If you have concerns or symptoms, please seek professional evaluation.';
    ctx.font = '12px Inter, Arial';
    ctx.fillStyle = '#444444';
    // start disclaimer below whichever is lower: subtitle (56) or demo box bottom
    const subtitleBottom = 56;
    const discYStart = Math.max(subtitleBottom + 8, demoY + demoHeight + 8);
    const discLineHeight = 16;
    const discEndY = wrapText(ctx, disclaimer, padding, discYStart, newCanvas.width - padding * 2, discLineHeight, 10);

    // Adjust header height based on disclaimer content and demo box
    const headerHeight = Math.max(headerHeightBase, discEndY + 12, demoY + demoHeight + 12);
    const chartY = headerHeight + 20;

    // Draw chart area border and title
    ctx.fillStyle = '#3b2f2f';
    ctx.font = '600 14px Inter, Arial';
    ctx.fillText('Audiogram', chartX, chartY - 6);
    ctx.strokeStyle = 'rgba(59,47,47,0.06)';
    ctx.strokeRect(chartX - 6, chartY - 12, chartWidth + 12, chartHeight + 12);

    // draw existing chart into report
    ctx.drawImage(canvas, chartX, chartY, chartWidth, chartHeight);

    // Analysis / findings section
    const thresholds = window.__lastResults || {};
    const maxDiff = thresholds.max_diff || 0;
    const asymmetryDetected = Math.abs(maxDiff) >= 20;
    const leftAvg = thresholds.left_avg ?? null;
    const rightAvg = thresholds.right_avg ?? null;

    const conclusionX = padding;
    const conclusionY = chartY + chartHeight + 28;
    ctx.font = '600 13px Inter, Arial';
    ctx.fillStyle = '#3b2f2f';
    ctx.fillText('Findings & interpretation', conclusionX, conclusionY + 2);

    ctx.font = '12px Inter, Arial';
    ctx.fillStyle = '#333333';
    const paraX = conclusionX;
    const paraWidth = newCanvas.width - padding * 2;
    const lineHeight = 18;

    // Build clearer findings text with key numbers
    const lines = [];
    lines.push(`Maximum interaural difference: ${Math.abs(maxDiff).toFixed(1)} dB.`);
    if (leftAvg !== null && rightAvg !== null) lines.push(`Average thresholds — Left: ${leftAvg.toFixed(1)} dB HL; Right: ${rightAvg.toFixed(1)} dB HL.`);
    if (asymmetryDetected) {
        lines.push('Interpretation: The screening indicates a notable interaural asymmetry which may represent unilateral or asymmetric hearing involvement.');
        lines.push('Recommendation: Follow-up assessment with a licensed audiologist or ENT specialist is advised for diagnostic audiometry and clinical evaluation.');
    } else {
        lines.push('Interpretation: No major interaural asymmetry was detected in this screening.');
        lines.push('Recommendation: If the patient experiences symptoms or concerns (e.g., sudden change, persistent tinnitus), consider referral for diagnostic assessment.');
    }

    // draw wrapped paragraph lines but prevent writing into footer area
    let oy = conclusionY + 18;
    ctx.fillStyle = '#444444';
    const maxY = newCanvas.height - footerHeight - 8;
    // render each constructed line with wrapping
    lines.forEach(text => {
        const end = wrapText(ctx, text, paraX, oy, paraWidth, lineHeight, 20);
        // wrapText returns bottom y; compute next start
        const used = Math.ceil((end - oy) / lineHeight);
        oy = oy + used * lineHeight + 6;
        if (oy > maxY) {
            // if we've reached the printable area, write ellipsis and stop
            ctx.fillText('...', paraX, Math.max(oy - 10, paraX + 10));
            oy = maxY;
        }
    });

    // Footer with date and app name
    const date = new Date().toISOString().split('T')[0];
    ctx.fillStyle = '#6b5b4b';
    ctx.font = '12px Inter, Arial';
    ctx.fillText(`Report date: ${date}`, padding, newCanvas.height - 12);
    ctx.fillText('Application: Hearing Asymmetry Screening (preliminary)', newCanvas.width - padding - 360, newCanvas.height - 12);

    return newCanvas;
}

async function downloadResults() {
    logDebug('Download results button clicked');
    try {
        const newCanvas = generateReportCanvas();
        const date = new Date().toISOString().split('T')[0];
        const link = document.createElement('a');
        link.download = `Hearing_Report_${(userName || 'user')}_${(userSurname || '')}_${date}.png`;
        link.href = newCanvas.toDataURL('image/png');
        link.click();
        logDebug('Report downloaded successfully');
    } catch (err) {
        console.error('Download results error:', err);
        alert('Failed to download results. Please try again.');
    }
}

async function downloadPDF() {
    logDebug('Download PDF requested');
    try {
        const newCanvas = generateReportCanvas();
        const imgData = newCanvas.toDataURL('image/png');
        // Use jsPDF if available
        if (window.jspdf && window.jspdf.jsPDF) {
            const { jsPDF } = window.jspdf;
            // landscape A4 approx size
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
            // compute image size to fit PDF while keeping aspect
            const pageW = pdf.internal.pageSize.getWidth();
            const pageH = pdf.internal.pageSize.getHeight();
            const imgW = newCanvas.width;
            const imgH = newCanvas.height;
            const scale = Math.min(pageW / imgW, pageH / imgH) * 0.95;
            const w = imgW * scale;
            const h = imgH * scale;
            const x = (pageW - w) / 2;
            const y = (pageH - h) / 2;
            pdf.addImage(imgData, 'PNG', x, y, w, h);
            const date = new Date().toISOString().split('T')[0];
            pdf.save(`Hearing_Report_${(userName || 'user')}_${(userSurname || '')}_${date}.pdf`);
        } else {
            alert('PDF export requires jsPDF. Please ensure the library is loaded.');
        }
    } catch (err) {
        console.error('Download PDF error:', err);
        alert('Failed to generate PDF. Please try again.');
    }
}

/* -----------------------
   Results screen and chart
   ----------------------- */
async function showResultsScreen(data) {
    logDebug(`Showing results screen with data: ${JSON.stringify(data)}`);
    showScreen('results');

    const thresholds = data.thresholds || { left: {}, right: {} };
    const leftAvg = (data.left_avg === undefined) ? 0 : data.left_avg;
    const rightAvg = (data.right_avg === undefined) ? 0 : data.right_avg;
    const maxDiff = (data.max_diff === undefined) ? 0 : data.max_diff;

    // Fill numeric results table (ascending order)
    const tbody = document.querySelector('#results-table tbody');
    if (tbody) tbody.innerHTML = '';
    testFrequencies.forEach(freq => {
        const left = thresholds.left[freq] !== undefined ? thresholds.left[freq] : '-';
        const right = thresholds.right[freq] !== undefined ? thresholds.right[freq] : '-';
        const diff = (left !== '-' && right !== '-') ? Math.abs(left - right).toFixed(1) : '-';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${freq}</td><td>${left}</td><td>${right}</td><td>${diff}</td>`;
        if (tbody) tbody.appendChild(tr);
    });

    // Chart (Chart.js)
    const ctx = document.getElementById('audiogram-chart')?.getContext('2d');
    if (!ctx) return;
    if (window.__audiogramChart) window.__audiogramChart.destroy();

    window.__audiogramChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: testFrequencies,
            datasets: [
                {
                    label: 'Left Ear (Blue)',
                    data: testFrequencies.map(f => thresholds.left[f] !== undefined ? thresholds.left[f] : null),
                    borderColor: '#007bff',
                    backgroundColor: '#007bff',
                    spanGaps: true,
                    tension: 0.2,
                    pointRadius: 6
                },
                {
                    label: 'Right Ear (Red)',
                    data: testFrequencies.map(f => thresholds.right[f] !== undefined ? thresholds.right[f] : null),
                    borderColor: '#e74c3c',
                    backgroundColor: '#e74c3c',
                    spanGaps: true,
                    tension: 0.2,
                    pointRadius: 6
                }
            ]

        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 5,
                    right: 5,
                    bottom: 5,
                    left: 5
                }
            },
            plugins: {
                legend: { 
                    position: 'top',
                    labels: {
                        padding: 10,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += `${context.parsed.y} dB HL at ${context.parsed.x} Hz`;
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { 
                        display: true, 
                        text: 'Frequency (Hz)',
                        padding: { top: 5, bottom: 5 }
                    },
                    ticks: {
                        callback: function (val, index, ticks) {
                            return Number(val).toFixed(0);
                        },
                        padding: 5
                    },
                    grid: {
                        display: true,
                        drawBorder: true
                    }
                },
                y: {
                    reverse: true,
                    title: { 
                        display: true, 
                        text: 'Threshold (dB HL)',
                        padding: { left: 5, right: 5 }
                    },
                    min: -10,
                    max: 40,
                    ticks: {
                        padding: 5
                    },
                    grid: {
                        display: true,
                        drawBorder: true
                    }
                }
            },
            hoverRadius: 8,
            hoverBorderWidth: 2,
            elements: {
                point: {
                    hoverRadius: 8
                }
            }
        }
    });

    const asymmetryDetected = (Math.abs(maxDiff) >= 20);
    const statusText = asymmetryDetected
        ? `⚠️ Asymmetry detected (max difference ${maxDiff.toFixed(1)} dB)`
        : `✅ No major asymmetry (max difference ${maxDiff.toFixed(1)} dB)`;
    const statusEl = document.getElementById('status-text');
    if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.style.color = asymmetryDetected ? '#c0392b' : '#2e7d5e';
    }

    // Add response reliability indicator
    const reliability = getReliabilityIndicator();
    const reliabilityEl = document.getElementById('reliability-indicator');
    if (reliabilityEl) {
        const reliabilityColor = reliability.level === 'high' ? '#2e7d5e' : 
                                reliability.level === 'medium' ? '#f39c12' : '#c0392b';
        reliabilityEl.innerHTML = `
            <span style="color: ${reliabilityColor};">
                Response Reliability: ${reliability.level.toUpperCase()}
            </span>
            <br>
            <small class="muted">${reliability.description}</small>
        `;
        
        if (reliability.level === 'low') {
            reliabilityEl.innerHTML += `
                <br>
                <small style="color: #c0392b;">
                    Consider retesting for more reliable results.
                </small>
            `;
        }
    }

    const recEl = document.getElementById('recommendation');
    if (recEl) recEl.textContent = asymmetryDetected
        ? 'Recommendation: Consult an audiologist for follow-up.'
        : 'This is a demo — if you have concerns, consult a professional.';

    // Analyze interaural differences for current results
    analyzeCurrentThresholds(thresholds).then(analysis => {
        if (analysis) {
            // Add interaural analysis section to results
            const resultsContainer = document.querySelector('#results-screen .panel-inner');
            const analysisSection = document.createElement('div');
            analysisSection.className = 'interaural-section';
            analysisSection.innerHTML = `
                <h3 class="subtitle">Interaural Threshold Analysis</h3>
                <div id="interaural-chart-container" class="chart-container-small">
                    <!-- Chart will be inserted here -->
                </div>
                <div class="analysis-disclaimer">
                    <p class="muted small">
                        <strong>Note:</strong> This analysis provides objective threshold measurements only. 
                        Differences ≥15 dB are highlighted for reference. No diagnostic interpretation is provided.
                    </p>
                </div>
            `;
            
            // Insert before the download buttons
            const ctaRow = resultsContainer.querySelector('.cta-row');
            resultsContainer.insertBefore(analysisSection, ctaRow);
            
            // Create the interaural difference chart
            createInterauralDifferenceChart(analysis, 'interaural-chart-container');
        }
    }).catch(error => {
        console.error('Failed to analyze interaural differences:', error);
    });

    // store for report generation
    window.__lastResults = {
        thresholds: thresholds,
        left_avg: leftAvg,
        right_avg: rightAvg,
        max_diff: maxDiff
    };

    // Save aggregated results (unchanged endpoint) - silent
    try {
        await fetchWithTimeout('/save_results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                left_avg: leftAvg,
                right_avg: rightAvg,
                dissimilarity: maxDiff
            }),
            timeout: 5000
        });
        logDebug('Results saved successfully');
    } catch (err) {
        console.error('Save results error:', err);
    }

    // Show feedback section after a brief delay
    setTimeout(() => {
        showFeedbackSection(data.session_id);
    }, 2000);
}

/* -----------------------
   Restart test
   ----------------------- */
function restartTest() {
    // Reset user state
    currentUser = {
        id: null,
        name: '',
        surname: '',
        gender: '',
        ageGroup: '',
        authType: 'guest',
        supabaseId: null,
        isAuthenticated: false
    };
    
    // Reset catch trial data
    catchTrialData = {
        totalCatchTrials: 0,
        correctCatchResponses: 0,
        trialsSinceLastCatch: 0,
        isCurrentTrialCatch: false,
        reliabilityScore: null
    };
    
    // Reset legacy variables
    userId = null;
    userName = '';
    userSurname = '';
    userGender = '';
    userAgeGroup = '';
    
    calibrationVolume = 0.2;
    const slider = document.getElementById('volume-slider');
    if (slider) slider.value = 0.2;
    showScreen('login');
    logDebug('Test restarted');
}

/* -----------------------
   Profile Management Functions
   ----------------------- */
function showProfileScreen() {
    if (!currentUser.isAuthenticated) {
        alert('Profile management is only available for authenticated users.');
        return;
    }
    
    // Populate form with current user data
    document.getElementById('profile-name-input').value = currentUser.name || '';
    document.getElementById('profile-surname-input').value = currentUser.surname || '';
    
    // Set radio buttons
    const ageRadio = document.querySelector(`input[name="profile_age_group"][value="${currentUser.ageGroup}"]`);
    if (ageRadio) ageRadio.checked = true;
    
    const genderRadio = document.querySelector(`input[name="profile_gender"][value="${currentUser.gender}"]`);
    if (genderRadio) genderRadio.checked = true;
    
    showScreen('profile');
}

async function saveProfile(e) {
    e.preventDefault();
    
    if (!currentUser.isAuthenticated) {
        showProfileError('Profile updates only available for authenticated users.');
        return;
    }
    
    const formData = {
        name: document.getElementById('profile-name-input').value,
        surname: document.getElementById('profile-surname-input').value,
        age_group: document.querySelector('input[name="profile_age_group"]:checked')?.value,
        gender: document.querySelector('input[name="profile_gender"]:checked')?.value
    };
    
    toggleLoader(true);
    try {
        const response = await fetchWithTimeout(`/user/profile?user_id=${currentUser.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData),
            timeout: 6000
        });
        
        if (!response.ok) throw new Error('Profile update failed');
        const result = await response.json();
        
        if (result.success && result.user) {
            updateUserState(result.user);
            updateUIForAuthState();
            toggleLoader(false);
            showScreen('welcome');
            logDebug('Profile updated successfully');
        } else {
            throw new Error('Invalid response from server');
        }
    } catch (error) {
        console.error('Profile update error:', error);
        showProfileError(error.message || 'Failed to update profile');
        toggleLoader(false);
    }
}

async function showHistoryScreen() {
    if (!currentUser.isAuthenticated) {
        alert('Test history is only available for authenticated users.');
        return;
    }
    
    showScreen('history');
    
    // Show loading state
    document.getElementById('history-loading').classList.remove('hidden');
    document.getElementById('history-empty').classList.add('hidden');
    document.getElementById('history-list').classList.add('hidden');
    
    try {
        const response = await fetchWithTimeout(`/user/test-history?user_id=${currentUser.id}&limit=20`, {
            timeout: 8000
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to load test history');
        }
        
        const result = await response.json();
        
        document.getElementById('history-loading').classList.add('hidden');
        
        if (result.statistics.total_sessions === 0) {
            document.getElementById('history-empty').classList.remove('hidden');
        } else {
            displayEnhancedTestHistory(result);
            document.getElementById('history-list').classList.remove('hidden');
        }
    } catch (error) {
        console.error('Test history error:', error);
        document.getElementById('history-loading').classList.add('hidden');
        document.getElementById('history-empty').classList.remove('hidden');
        
        const errorMsg = error.message.includes('authenticated') 
            ? 'Please sign in to view your test history.'
            : 'Failed to load test history. Please try again.';
        document.querySelector('#history-empty p').textContent = errorMsg;
    }
}

function displayEnhancedTestHistory(data) {
    // Store history data globally for audiogram overlay
    historyData = data;
    
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';
    
    // Add statistics header with trend analysis and educational summary
    const statsHeader = document.createElement('div');
    statsHeader.className = 'history-stats';
    
    let trendSection = '';
    if (data.trend_analysis && data.trend_analysis.classification !== 'insufficient_data') {
        const trend = data.trend_analysis;
        const trendClass = getTrendDisplayClass(trend.classification);
        
        trendSection = `
            <div class="trend-analysis-section">
                <h4>Measurement Pattern Analysis</h4>
                <div class="trend-summary">
                    <span class="trend-badge ${trendClass}">${formatTrendClassification(trend.classification)}</span>
                    <span class="trend-description">${trend.description}</span>
                </div>
                <div class="trend-details">
                    <small class="muted">
                        Based on ${trend.sessions_analyzed} sessions over ${trend.time_span_days} days • 
                        ${trend.disclaimer}
                    </small>
                </div>
            </div>
        `;
    }
    
    // Add educational summary section
    let summarySection = '';
    if (data.educational_summary && data.educational_summary.summary_type !== 'insufficient_data') {
        summarySection = displayEducationalSummary(data.educational_summary);
    }
    
    statsHeader.innerHTML = `
        <div class="stats-grid">
            <div class="stat-item">
                <span class="stat-value">${data.statistics.total_sessions}</span>
                <span class="stat-label">Total Tests</span>
            </div>
            <div class="stat-item">
                <span class="stat-value">${data.statistics.recent_sessions_30d}</span>
                <span class="stat-label">Last 30 Days</span>
            </div>
            <div class="stat-item">
                <span class="stat-value">${data.statistics.returned_sessions}</span>
                <span class="stat-label">Showing</span>
            </div>
        </div>
        ${trendSection}
        ${summarySection}
    `;
    historyList.appendChild(statsHeader);
    
    if (data.history.length === 0) {
        historyList.innerHTML += '<p class="muted">No test history available.</p>';
        return;
    }
    
    data.history.forEach((session, index) => {
        const sessionDate = new Date(session.timestamp);
        const isRecent = (Date.now() - sessionDate.getTime()) < (7 * 24 * 60 * 60 * 1000);
        const isComplete = session.metadata.is_complete;
        const hasAsymmetry = session.summary.asymmetry_detected;
        
        const sessionItem = document.createElement('div');
        sessionItem.className = `history-item ${isRecent ? 'recent' : ''} ${!isComplete ? 'incomplete' : ''}`;
        
        // Create frequency breakdown
        let frequencyDetails = '';
        if (session.thresholds && (session.thresholds.left || session.thresholds.right)) {
            const frequencies = [250, 500, 1000, 2000, 4000, 5000];
            frequencyDetails = `
                <div class="frequency-breakdown">
                    <div class="breakdown-header">
                        <h5>Detailed Results (dB HL)</h5>
                        <button class="btn ghost tiny" onclick="viewSessionDetails('${session.session_id}')">
                            View Details
                        </button>
                    </div>
                    <div class="freq-headers">
                        <span>Frequency</span>
                        <span>Left</span>
                        <span>Right</span>
                        <span>Diff</span>
                    </div>
                    <div class="frequency-grid">
                        ${frequencies.map(freq => {
                            const leftVal = session.thresholds.left?.[freq];
                            const rightVal = session.thresholds.right?.[freq];
                            const diff = (leftVal !== undefined && rightVal !== undefined) 
                                ? Math.abs(leftVal - rightVal).toFixed(1) 
                                : 'N/A';
                            const isSignificant = diff !== 'N/A' && parseFloat(diff) >= 15;
                            return `
                                <div class="freq-row ${isSignificant ? 'significant-diff' : ''}">
                                    <span class="freq-label">${freq} Hz</span>
                                    <span class="left-val">${leftVal?.toFixed(1) || 'N/A'}</span>
                                    <span class="right-val">${rightVal?.toFixed(1) || 'N/A'}</span>
                                    <span class="diff-val ${isSignificant ? 'significant' : ''}">${diff}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        // Quality indicators
        const qualityBadges = [];
        if (isComplete) qualityBadges.push('<span class="badge success">Complete</span>');
        else qualityBadges.push('<span class="badge warning">Incomplete</span>');
        
        if (hasAsymmetry) qualityBadges.push('<span class="badge alert">Asymmetry Detected</span>');
        else qualityBadges.push('<span class="badge info">Normal Symmetry</span>');
        
        sessionItem.innerHTML = `
            <div class="history-header">
                <div class="session-title">
                    <h4>Test ${data.history.length - index} ${isRecent ? '🆕' : ''}</h4>
                    <div class="quality-badges">${qualityBadges.join('')}</div>
                </div>
                <div class="session-meta">
                    <span class="test-date">${sessionDate.toLocaleDateString()}</span>
                    <span class="test-time">${sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                </div>
            </div>
            <div class="history-details">
                <div class="result-summary">
                    <span class="avg-result">Left Avg: ${session.summary.left_avg?.toFixed(1) || 'N/A'} dB HL</span>
                    <span class="avg-result">Right Avg: ${session.summary.right_avg?.toFixed(1) || 'N/A'} dB HL</span>
                    <span class="diff-result ${hasAsymmetry ? 'significant' : ''}">
                        Max Difference: ${session.summary.dissimilarity?.toFixed(1) || 'N/A'} dB
                        ${hasAsymmetry ? ' ⚠️' : ' ✓'}
                    </span>
                </div>
                ${frequencyDetails}
                ${displayInterauralDifferences(session)}
                <div class="session-info">
                    <small class="muted">
                        Session: ${session.session_id} • 
                        Completeness: ${session.metadata.frequency_count}/${session.metadata.completeness.total_expected} frequencies
                    </small>
                </div>
            </div>
        `;
        historyList.appendChild(sessionItem);
    });
    
    // Add load more button if there are more sessions
    if (data.statistics.has_more) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'btn ghost load-more-btn';
        loadMoreBtn.textContent = 'Load More Sessions';
        loadMoreBtn.onclick = () => loadMoreHistory(data.statistics.pagination.next_offset);
        historyList.appendChild(loadMoreBtn);
    }
}

async function viewSessionDetails(sessionId) {
    try {
        const response = await fetchWithTimeout(`/user/session/${sessionId}?user_id=${currentUser.id}`, {
            timeout: 5000
        });
        
        if (!response.ok) throw new Error('Failed to load session details');
        const sessionData = await response.json();
        
        // Display detailed session information (could open a modal or new screen)
        console.log('Session details:', sessionData);
        alert(`Session Details:\n\nFrequencies tested: ${sessionData.analysis.frequencies_tested}\nSignificant asymmetries: ${sessionData.analysis.significant_frequencies.length}`);
        
    } catch (error) {
        console.error('Session details error:', error);
        alert('Failed to load session details.');
    }
}

async function loadMoreHistory(offset) {
    // Implementation for pagination - load additional sessions
    logDebug(`Loading more history from offset ${offset}`);
    // This would append additional sessions to the existing list
}

/* -----------------------
   Audiogram Overlay System
   ----------------------- */
let historyData = null;
let historyAudiogramChart = null;
let selectedSessions = new Set();

function switchHistoryTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    // Show/hide tab content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    
    if (tabName === 'list') {
        document.getElementById('history-list-view').classList.remove('hidden');
    } else if (tabName === 'audiogram') {
        document.getElementById('history-audiogram-view').classList.remove('hidden');
        if (historyData && historyData.history.length > 0) {
            initializeAudiogramOverlay();
        }
    }
}

function initializeAudiogramOverlay() {
    if (!historyData || historyData.history.length === 0) {
        return;
    }
    
    // Populate session toggles
    populateSessionToggles();
    
    // Initialize with latest 3 sessions selected
    const latestSessions = historyData.history.slice(0, Math.min(3, historyData.history.length));
    selectedSessions.clear();
    latestSessions.forEach(session => selectedSessions.add(session.session_id));
    
    // Update toggle states
    updateToggleStates();
    
    // Create the overlay chart
    createAudiogramOverlay();
}

function populateSessionToggles() {
    const togglesContainer = document.getElementById('session-toggles');
    togglesContainer.innerHTML = '';
    
    historyData.history.forEach((session, index) => {
        const sessionDate = new Date(session.timestamp);
        const isComplete = session.metadata.is_complete;
        
        const toggleItem = document.createElement('div');
        toggleItem.className = `session-toggle ${!isComplete ? 'incomplete' : ''}`;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `session-${session.session_id}`;
        checkbox.value = session.session_id;
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedSessions.add(session.session_id);
            } else {
                selectedSessions.delete(session.session_id);
            }
            updateAudiogramOverlay();
        });
        
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.innerHTML = `
            <span class="session-info">
                <span class="session-title">Test ${historyData.history.length - index}</span>
                <span class="session-date">${sessionDate.toLocaleDateString()}</span>
                <span class="session-time">${sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </span>
            <span class="session-summary">
                L: ${session.summary.left_avg?.toFixed(1) || 'N/A'} | 
                R: ${session.summary.right_avg?.toFixed(1) || 'N/A'} | 
                Diff: ${session.summary.dissimilarity?.toFixed(1) || 'N/A'} dB
                ${!isComplete ? ' (Incomplete)' : ''}
            </span>
        `;
        
        toggleItem.appendChild(checkbox);
        toggleItem.appendChild(label);
        togglesContainer.appendChild(toggleItem);
    });
}

function updateToggleStates() {
    historyData.history.forEach(session => {
        const checkbox = document.getElementById(`session-${session.session_id}`);
        if (checkbox) {
            checkbox.checked = selectedSessions.has(session.session_id);
        }
    });
}

function toggleAllSessions(selectAll) {
    selectedSessions.clear();
    
    if (selectAll) {
        historyData.history.forEach(session => {
            if (session.metadata.is_complete) { // Only select complete sessions
                selectedSessions.add(session.session_id);
            }
        });
    }
    
    updateToggleStates();
    updateAudiogramOverlay();
}

function showLatest5Sessions() {
    selectedSessions.clear();
    
    const latestComplete = historyData.history
        .filter(session => session.metadata.is_complete)
        .slice(0, 5);
    
    latestComplete.forEach(session => selectedSessions.add(session.session_id));
    
    updateToggleStates();
    updateAudiogramOverlay();
}

function createAudiogramOverlay() {
    const ctx = document.getElementById('history-audiogram-chart')?.getContext('2d');
    if (!ctx) return;
    
    // Destroy existing chart
    if (historyAudiogramChart) {
        historyAudiogramChart.destroy();
    }
    
    const datasets = [];
    const colors = [
        '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
        '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6b7280'
    ];
    
    let colorIndex = 0;
    
    // Create datasets for selected sessions
    Array.from(selectedSessions).forEach(sessionId => {
        const session = historyData.history.find(s => s.session_id === sessionId);
        if (!session || !session.thresholds) return;
        
        const sessionDate = new Date(session.timestamp);
        const sessionLabel = `${sessionDate.toLocaleDateString()} ${sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        
        // Left ear dataset
        const leftColor = colors[colorIndex % colors.length];
        datasets.push({
            label: `${sessionLabel} - Left`,
            data: testFrequencies.map(f => session.thresholds.left?.[f] || null),
            borderColor: leftColor,
            backgroundColor: leftColor + '20',
            pointBackgroundColor: leftColor,
            pointBorderColor: leftColor,
            pointRadius: 6,
            pointHoverRadius: 8,
            tension: 0.2,
            spanGaps: true,
            borderWidth: 2,
            pointStyle: 'circle'
        });
        
        // Right ear dataset
        const rightColor = colors[(colorIndex + 1) % colors.length];
        datasets.push({
            label: `${sessionLabel} - Right`,
            data: testFrequencies.map(f => session.thresholds.right?.[f] || null),
            borderColor: rightColor,
            backgroundColor: rightColor + '20',
            pointBackgroundColor: rightColor,
            pointBorderColor: rightColor,
            pointRadius: 6,
            pointHoverRadius: 8,
            tension: 0.2,
            spanGaps: true,
            borderWidth: 2,
            pointStyle: 'triangle',
            borderDash: [5, 5] // Dashed line for right ear
        });
        
        colorIndex += 2;
    });
    
    historyAudiogramChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: testFrequencies,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 5,
                    right: 5,
                    bottom: 5,
                    left: 5
                }
            },
            plugins: {
                title: {
                    display: true,
                    text: 'Historical Audiogram Overlay',
                    font: { size: 16, weight: 'bold' },
                    padding: { top: 5, bottom: 10 }
                },
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        padding: 10,
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            return `${context[0].parsed.x} Hz`;
                        },
                        label: function(context) {
                            const ear = context.dataset.label.includes('Left') ? 'Left' : 'Right';
                            const date = context.dataset.label.split(' - ')[0];
                            return `${date} ${ear}: ${context.parsed.y} dB HL`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { 
                        display: true, 
                        text: 'Frequency (Hz)',
                        font: { weight: 'bold' },
                        padding: { top: 10, bottom: 10 }
                    },
                    ticks: {
                        callback: function(val, index, ticks) {
                            return Number(val).toFixed(0);
                        },
                        padding: 10
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        display: true,
                        drawBorder: true
                    }
                },
                y: {
                    reverse: true,
                    title: { 
                        display: true, 
                        text: 'Threshold (dB HL)',
                        font: { weight: 'bold' },
                        padding: { left: 10, right: 10 }
                    },
                    min: -10,
                    max: 40,
                    ticks: {
                        padding: 10
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        display: true,
                        drawBorder: true
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index'
            }
        }
    });
    
    // Update legend
    updateAudiogramLegend();
}

function updateAudiogramOverlay() {
    if (historyAudiogramChart) {
        createAudiogramOverlay(); // Recreate chart with new selection
    }
}

function updateAudiogramLegend() {
    const legendContainer = document.getElementById('audiogram-legend');
    if (!legendContainer) return;
    
    legendContainer.innerHTML = `
        <div class="legend-section">
            <h5>Chart Legend</h5>
            <div class="legend-items">
                <div class="legend-item">
                    <span class="legend-symbol circle"></span>
                    <span>Left Ear (Solid Line)</span>
                </div>
                <div class="legend-item">
                    <span class="legend-symbol triangle"></span>
                    <span>Right Ear (Dashed Line)</span>
                </div>
            </div>
            <p class="legend-note">
                <strong>Note:</strong> ${selectedSessions.size} session(s) displayed. 
                Toggle sessions above to compare different test dates.
            </p>
        </div>
    `;
}

function displayTestHistory(history) {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';
    
    if (history.length === 0) {
        historyList.innerHTML = '<p class="muted">No test history available.</p>';
        return;
    }
    
    history.forEach((test, index) => {
        const testDate = new Date(test.date);
        const isRecent = (Date.now() - testDate.getTime()) < (7 * 24 * 60 * 60 * 1000); // Within 7 days
        
        const testItem = document.createElement('div');
        testItem.className = `history-item ${isRecent ? 'recent' : ''}`;
        
        // Create frequency breakdown if available
        let frequencyDetails = '';
        if (test.thresholds && (test.thresholds.left || test.thresholds.right)) {
            const frequencies = [250, 500, 1000, 2000, 4000, 5000];
            frequencyDetails = `
                <div class="frequency-breakdown">
                    <h5>Detailed Results (dB HL)</h5>
                    <div class="frequency-grid">
                        ${frequencies.map(freq => {
                            const leftVal = test.thresholds.left?.[freq];
                            const rightVal = test.thresholds.right?.[freq];
                            const diff = (leftVal !== undefined && rightVal !== undefined) 
                                ? Math.abs(leftVal - rightVal).toFixed(1) 
                                : 'N/A';
                            return `
                                <div class="freq-row">
                                    <span class="freq-label">${freq} Hz</span>
                                    <span class="left-val">${leftVal?.toFixed(1) || 'N/A'}</span>
                                    <span class="right-val">${rightVal?.toFixed(1) || 'N/A'}</span>
                                    <span class="diff-val ${diff !== 'N/A' && parseFloat(diff) >= 20 ? 'significant' : ''}">${diff}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div class="freq-headers">
                        <span>Frequency</span>
                        <span>Left</span>
                        <span>Right</span>
                        <span>Diff</span>
                    </div>
                </div>
            `;
        }
        
        testItem.innerHTML = `
            <div class="history-header">
                <h4>Test ${history.length - index} ${isRecent ? '🆕' : ''}</h4>
                <span class="test-date">${testDate.toLocaleDateString()} ${testDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </div>
            <div class="history-details">
                <div class="result-summary">
                    <span class="avg-result">Left Avg: ${test.left_avg?.toFixed(1) || 'N/A'} dB HL</span>
                    <span class="avg-result">Right Avg: ${test.right_avg?.toFixed(1) || 'N/A'} dB HL</span>
                    <span class="diff-result ${test.dissimilarity >= 20 ? 'significant' : ''}">
                        Max Difference: ${test.dissimilarity?.toFixed(1) || 'N/A'} dB
                        ${test.dissimilarity >= 20 ? ' ⚠️' : ' ✓'}
                    </span>
                </div>
                ${frequencyDetails}
                <div class="session-info">
                    <small class="muted">Session ID: ${test.session_id || 'N/A'}</small>
                </div>
            </div>
        `;
        historyList.appendChild(testItem);
    });
}

function showProfileError(message) {
    const errorEl = document.getElementById('profile-error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

/* -----------------------
   Trend Analysis Display Functions
   ----------------------- */
function getTrendDisplayClass(classification) {
    switch (classification) {
        case 'stable':
            return 'trend-stable';
        case 'variable':
            return 'trend-variable';
        case 'changing':
            return 'trend-changing';
        default:
            return 'trend-unknown';
    }
}

function formatTrendClassification(classification) {
    switch (classification) {
        case 'stable':
            return 'Stable';
        case 'variable':
            return 'Variable';
        case 'changing':
            return 'Changing';
        case 'insufficient_data':
            return 'Insufficient Data';
        case 'analysis_error':
            return 'Analysis Error';
        default:
            return 'Unknown';
    }
}

async function fetchDetailedTrendAnalysis() {
    if (!currentUser.isAuthenticated) {
        return null;
    }
    
    try {
        const response = await fetchWithTimeout(`/user/trend-analysis?user_id=${currentUser.id}`, {
            timeout: 5000
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch trend analysis');
        }
        
        const data = await response.json();
        return data.trend_analysis;
    } catch (error) {
        console.error('Trend analysis fetch error:', error);
        return null;
    }
}

function displayDetailedTrendAnalysis(trendData) {
    if (!trendData || trendData.classification === 'insufficient_data') {
        return '<p class="muted">Insufficient data for trend analysis</p>';
    }
    
    const metrics = trendData.metrics || {};
    const sessionRange = trendData.session_range || {};
    
    return `
        <div class="detailed-trend-analysis">
            <h5>Detailed Pattern Analysis</h5>
            <div class="trend-classification">
                <span class="trend-badge ${getTrendDisplayClass(trendData.classification)}">
                    ${formatTrendClassification(trendData.classification)}
                </span>
                <p class="trend-description">${trendData.description}</p>
            </div>
            
            <div class="trend-metrics">
                <h6>Measurement Variability</h6>
                <div class="metrics-grid">
                    <div class="metric-item">
                        <span class="metric-label">Overall Variance</span>
                        <span class="metric-value">${metrics.overall_variance || 'N/A'} dB²</span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-label">Left Ear Variance</span>
                        <span class="metric-value">${metrics.left_ear_variance || 'N/A'} dB²</span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-label">Right Ear Variance</span>
                        <span class="metric-value">${metrics.right_ear_variance || 'N/A'} dB²</span>
                    </div>
                    <div class="metric-item">
                        <span class="metric-label">Interaural Variance</span>
                        <span class="metric-value">${metrics.interaural_variance || 'N/A'} dB²</span>
                    </div>
                </div>
            </div>
            
            ${sessionRange.earliest ? `
                <div class="trend-timeline">
                    <h6>Analysis Period</h6>
                    <div class="timeline-info">
                        <span>Sessions: ${trendData.sessions_analyzed}</span>
                        <span>Time span: ${trendData.time_span_days} days</span>
                        <span>First avg: ${sessionRange.first_avg} dB HL</span>
                        <span>Latest avg: ${sessionRange.last_avg} dB HL</span>
                    </div>
                </div>
            ` : ''}
            
            <div class="trend-disclaimer">
                <p class="muted small">
                    <strong>Note:</strong> ${trendData.disclaimer}
                </p>
            </div>
        </div>
    `;
}

/* -----------------------
   Educational Summary Display
   ----------------------- */
function displayEducationalSummary(summary) {
    if (!summary || summary.summary_type === 'insufficient_data') {
        return '';
    }
    
    const summaryClass = getSummaryDisplayClass(summary.pattern_classification);
    
    let keyObservationsHtml = '';
    if (summary.key_observations && summary.key_observations.length > 0) {
        keyObservationsHtml = `
            <div class="summary-observations">
                <h6>Key Observations</h6>
                <ul class="observation-list">
                    ${summary.key_observations.map(obs => `<li>${obs}</li>`).join('')}
                </ul>
            </div>
        `;
    }
    
    let educationalNotesHtml = '';
    if (summary.educational_notes && summary.educational_notes.length > 0) {
        educationalNotesHtml = `
            <div class="summary-education">
                <h6>Educational Information</h6>
                <ul class="education-list">
                    ${summary.educational_notes.map(note => `<li>${note}</li>`).join('')}
                </ul>
            </div>
        `;
    }
    
    let recommendationsHtml = '';
    if (summary.recommendations && summary.recommendations.length > 0) {
        recommendationsHtml = `
            <div class="summary-recommendations">
                <h6>Recommendations</h6>
                <ul class="recommendation-list">
                    ${summary.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                </ul>
            </div>
        `;
    }
    
    return `
        <div class="educational-summary-section">
            <div class="summary-header">
                <h4>${summary.title}</h4>
                <span class="summary-period">${summary.analysis_period}</span>
            </div>
            
            <div class="summary-main-message ${summaryClass}">
                <p class="main-message">${summary.main_message}</p>
            </div>
            
            <div class="summary-content">
                ${keyObservationsHtml}
                ${educationalNotesHtml}
                ${recommendationsHtml}
            </div>
            
            <div class="summary-disclaimer">
                <p class="disclaimer-text">
                    <strong>Important:</strong> ${summary.disclaimer}
                </p>
            </div>
        </div>
    `;
}

function getSummaryDisplayClass(classification) {
    switch (classification) {
        case 'stable':
            return 'summary-stable';
        case 'variable':
            return 'summary-variable';
        case 'changing':
            return 'summary-changing';
        default:
            return 'summary-neutral';
    }
}

async function fetchEducationalSummary() {
    if (!currentUser.isAuthenticated) {
        return null;
    }
    
    try {
        const response = await fetchWithTimeout(`/user/measurement-summary?user_id=${currentUser.id}`, {
            timeout: 8000
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch educational summary');
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Educational summary fetch error:', error);
        return null;
    }
}

function displayProfessionalGuidance(guidanceData) {
    if (!guidanceData) return '';
    
    const importantNotes = guidanceData.important_notes || {};
    const seekHelp = guidanceData.when_to_seek_professional_help || [];
    
    return `
        <div class="professional-guidance">
            <h5>Professional Consultation Guidance</h5>
            
            <div class="guidance-notes">
                <h6>Important Reminders</h6>
                <ul class="guidance-list">
                    <li><strong>Screening Nature:</strong> ${importantNotes.screening_nature}</li>
                    <li><strong>Professional Evaluation:</strong> ${importantNotes.professional_evaluation}</li>
                    <li><strong>Measurement Limitations:</strong> ${importantNotes.measurement_limitations}</li>
                </ul>
            </div>
            
            ${seekHelp.length > 0 ? `
                <div class="seek-help-section">
                    <h6>Consider Professional Evaluation If You Experience:</h6>
                    <ul class="seek-help-list">
                        ${seekHelp.map(item => `<li>${item}</li>`).join('')}
                    </ul>
                </div>
            ` : ''}
            
            <div class="consultation-reminder">
                <p class="consultation-text">
                    <strong>Remember:</strong> ${importantNotes.consultation_guidance}
                </p>
            </div>
        </div>
    `;
}

/* -----------------------
   Contextual Test Guidance
   ----------------------- */
function initializeTestGuidance() {
    // Help panel toggle
    const helpBtn = document.getElementById('guidance-help');
    const helpPanel = document.getElementById('help-panel');
    const closeHelpBtn = document.getElementById('close-help');
    
    if (helpBtn && helpPanel) {
        helpBtn.addEventListener('click', () => {
            helpPanel.classList.toggle('hidden');
            helpPanel.setAttribute('aria-modal', !helpPanel.classList.contains('hidden'));
        });
    }
    
    if (closeHelpBtn && helpPanel) {
        closeHelpBtn.addEventListener('click', () => {
            helpPanel.classList.add('hidden');
            helpPanel.setAttribute('aria-modal', 'false');
        });
    }
    
    // Pause functionality
    const pauseBtn = document.getElementById('pause-test');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', pauseTest);
    }
    
    // Initialize guidance state
    updateTestGuidance('preparing', 'Getting ready to start your hearing test...');
}

function updateTestGuidance(phase, message, details = {}) {
    const guidanceTitle = document.getElementById('guidance-title');
    const guidanceMessage = document.getElementById('guidance-message');
    const guidanceIcon = document.querySelector('.guidance-icon');
    
    // Phase-specific guidance
    const phaseConfig = {
        preparing: {
            title: 'Getting Ready',
            icon: '🎯',
            message: message || 'Preparing your hearing test...'
        },
        starting: {
            title: 'Test Starting',
            icon: '🚀',
            message: message || 'Your hearing test is about to begin...'
        },
        testing: {
            title: 'Testing in Progress',
            icon: '🎧',
            message: message || 'Listen carefully for the tone...'
        },
        switching: {
            title: 'Switching Ears',
            icon: '🔄',
            message: message || 'Now testing the other ear...'
        },
        completing: {
            title: 'Almost Done',
            icon: '🏁',
            message: message || 'Finishing up your hearing test...'
        },
        completed: {
            title: 'Test Complete',
            icon: '✅',
            message: message || 'Your hearing test is complete!'
        }
    };
    
    const config = phaseConfig[phase] || phaseConfig.testing;
    
    if (guidanceTitle) guidanceTitle.textContent = config.title;
    if (guidanceMessage) guidanceMessage.textContent = config.message;
    if (guidanceIcon) guidanceIcon.textContent = config.icon;
    
    // Update test context information
    updateTestContext(details);
}

function updateTestContext(details) {
    const currentEar = document.getElementById('current-ear');
    const currentFreq = document.getElementById('current-frequency');
    const currentLevel = document.getElementById('current-level');
    
    if (details.ear && currentEar) {
        currentEar.textContent = `${details.ear.charAt(0).toUpperCase() + details.ear.slice(1)} Ear`;
    }
    
    if (details.frequency && currentFreq) {
        currentFreq.textContent = `${details.frequency} Hz`;
    }
    
    if (details.level !== undefined && currentLevel) {
        currentLevel.textContent = `${details.level} dB HL`;
    }
}

function updateProgressWithPhases(progress, testNumber, totalTests) {
    const progressBar = document.getElementById('progress-bar');
    const progressLabel = document.getElementById('progress-label');
    const progressText = document.getElementById('progress-text');
    const progressSection = document.querySelector('.progress-section');
    
    if (progressBar) {
        progressBar.value = progress;
        progressSection.setAttribute('aria-valuenow', progress);
    }
    
    if (progressLabel) {
        progressLabel.textContent = `${Math.round(progress)}%`;
    }
    
    if (progressText) {
        if (testNumber && totalTests) {
            progressText.textContent = `Test ${testNumber} of ${totalTests}`;
        } else {
            progressText.textContent = `${Math.round(progress)}% complete`;
        }
    }
    
    // Update phase markers
    const phaseMarkers = document.querySelectorAll('.phase-marker');
    phaseMarkers.forEach(marker => {
        const phase = parseInt(marker.dataset.phase);
        marker.classList.toggle('active', progress >= phase);
        marker.classList.toggle('current', Math.abs(progress - phase) < 12.5);
    });
}

function updateInstructionText(phase, earSide, frequency) {
    const instructionTitle = document.getElementById('instruction-title');
    const instructionText = document.getElementById('instruction-text');
    const instructionTips = document.getElementById('instruction-tips');
    
    let title = 'Listen Carefully';
    let text = 'A tone will play. Click "YES" if you hear it, "NO" if you don\'t.';
    let tips = [];
    
    switch (phase) {
        case 'first_tone':
            title = 'Listen Carefully';
            text = `Listen for a tone in your ${earSide} ear.`;
            tips = [];
            break;
            
        case 'threshold_finding':
            title = 'Threshold Detection';
            text = `Listen carefully for tones in your ${earSide} ear at ${frequency} Hz.`;
            tips = [];
            break;
            
        case 'ear_switching':
            title = 'Testing Other Ear';
            text = `Now testing your ${earSide} ear.`;
            tips = [];
            break;
            
        case 'frequency_change':
            title = 'New Frequency';
            text = `Testing ${frequency} Hz in your ${earSide} ear.`;
            tips = [];
            break;
    }
    
    if (instructionTitle) instructionTitle.textContent = title;
    if (instructionText) instructionText.textContent = text;
    
    // Clear any existing tips for clean professional appearance
    if (instructionTips) {
        instructionTips.innerHTML = '';
    }
}

function updateEarStatus(ear, status, message = '') {
    const earElement = document.getElementById(`${ear}-ear-icon`);
    const statusElement = document.getElementById(`${ear}-ear-status`);
    
    if (earElement) {
        // Remove all status classes
        earElement.classList.remove('ear-active', 'ear-inactive', 'ear-testing', 'ear-complete');
        
        // Add current status
        earElement.classList.add(`ear-${status}`);
        
        // Update ARIA attributes
        if (status === 'testing') {
            earElement.setAttribute('aria-label', `${ear} ear - currently being tested`);
        } else if (status === 'complete') {
            earElement.setAttribute('aria-label', `${ear} ear - testing complete`);
        } else {
            earElement.setAttribute('aria-label', `${ear} ear`);
        }
    }
    
    if (statusElement) {
        statusElement.textContent = message;
    }
}

function showToneIndicator(isPlaying, toneInfo = {}) {
    const indicator = document.getElementById('tone-indicator');
    const icon = indicator?.querySelector('.indicator-icon');
    const status = document.getElementById('response-status');
    
    if (isPlaying) {
        if (icon) icon.textContent = '🔊';
        if (status) {
            const freq = toneInfo.frequency ? `${toneInfo.frequency} Hz` : '';
            // Don't show level for catch trials (would reveal 0 dB HL)
            const level = (toneInfo.level && !toneInfo.isCatchTrial) ? `${toneInfo.level} dB HL` : '';
            status.textContent = `Playing tone: ${freq} ${level}`.trim();
        }
        indicator?.classList.add('playing');
    } else {
        if (icon) icon.textContent = '🔊';
        if (status) status.textContent = 'Did you hear the tone?';
        indicator?.classList.remove('playing');
    }
}

function enableResponseButtons(enable = true) {
    const yesBtn = document.getElementById('yes-btn');
    const noBtn = document.getElementById('no-btn');
    
    if (yesBtn) yesBtn.disabled = !enable;
    if (noBtn) noBtn.disabled = !enable;
    
    // Update button appearance for accessibility
    if (enable) {
        yesBtn?.classList.add('btn-ready');
        noBtn?.classList.add('btn-ready');
    } else {
        yesBtn?.classList.remove('btn-ready');
        noBtn?.classList.remove('btn-ready');
    }
}

function pauseTest() {
    // Implementation for pause functionality
    const pauseBtn = document.getElementById('pause-test');
    if (pauseBtn) {
        const isPaused = pauseBtn.textContent.includes('Resume');
        
        if (isPaused) {
            pauseBtn.innerHTML = '<span aria-hidden="true">⏸️</span> Pause';
            updateTestGuidance('testing', 'Test resumed. Listen for the next tone...');
        } else {
            pauseBtn.innerHTML = '<span aria-hidden="true">▶️</span> Resume';
            updateTestGuidance('testing', 'Test paused. Click Resume when ready to continue.');
        }
    }
}

/* -----------------------
   Onboarding Assistant
   ----------------------- */
function initializeOnboardingAssistant() {
    // Step navigation
    const stepButtons = document.querySelectorAll('.step-btn');
    stepButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const step = e.target.dataset.step;
            switchAssistantStep(step);
        });
    });
    
    // Toggle assistant visibility
    const toggleBtn = document.getElementById('toggle-assistant');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleAssistantVisibility);
    }
    
    // FAQ toggles
    const faqQuestions = document.querySelectorAll('.faq-question');
    faqQuestions.forEach(question => {
        question.addEventListener('click', toggleFAQItem);
    });
    
    // Readiness checklist - checkboxes remain for user reference but no longer control button state
    
    // Assistant start button removed for cleaner interface
    
    // Initialize with first step
    switchAssistantStep('purpose');
}

function switchAssistantStep(stepName) {
    // Update step buttons
    document.querySelectorAll('.step-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.step === stepName);
    });
    
    // Update step panels
    document.querySelectorAll('.step-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `step-${stepName}`);
    });
    
    // Add animation
    const activePanel = document.getElementById(`step-${stepName}`);
    if (activePanel) {
        activePanel.style.animation = 'none';
        activePanel.offsetHeight; // Trigger reflow
        activePanel.style.animation = 'fadeInUp 0.3s ease-out';
    }
}

function toggleAssistantVisibility() {
    const assistant = document.getElementById('onboarding-assistant');
    const toggleBtn = document.getElementById('toggle-assistant');
    const content = document.getElementById('assistant-content');
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        toggleBtn.textContent = 'Hide Guide';
        assistant.classList.remove('collapsed');
    } else {
        content.style.display = 'none';
        toggleBtn.textContent = 'Show Guide';
        assistant.classList.add('collapsed');
    }
}

function toggleFAQItem(e) {
    const question = e.target;
    const faqItem = question.closest('.faq-item');
    const answer = faqItem.querySelector('.faq-answer');
    const toggle = question.querySelector('.faq-toggle');
    
    const isOpen = answer.style.display === 'block';
    
    if (isOpen) {
        answer.style.display = 'none';
        toggle.textContent = '+';
        faqItem.classList.remove('open');
    } else {
        answer.style.display = 'block';
        toggle.textContent = '−';
        faqItem.classList.add('open');
    }
}

// Removed updateReadinessStatus function - no longer needed without the assistant start button

// Removed showOnboardingTip function for cleaner professional interface

function getOnboardingProgress() {
    const checkboxes = document.querySelectorAll('.readiness-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    return {
        completed: checkedCount,
        total: checkboxes.length,
        percentage: Math.round((checkedCount / checkboxes.length) * 100)
    };
}

/* -----------------------
   Interaural Difference Analysis
   ----------------------- */
function displayInterauralDifferences(session) {
    if (!session.interaural_differences || !session.interaural_differences.has_analysis) {
        return '<p class="muted small">No interaural analysis available</p>';
    }
    
    const perFreq = session.interaural_differences.per_frequency;
    const stats = session.interaural_differences.summary_stats;
    
    if (!perFreq || Object.keys(perFreq).length === 0) {
        return '<p class="muted small">Insufficient data for interaural analysis</p>';
    }
    
    // Sort frequencies for display
    const frequencies = Object.keys(perFreq).map(f => parseInt(f)).sort((a, b) => a - b);
    
    let html = `
        <div class="interaural-analysis">
            <h6>Interaural Threshold Differences</h6>
            <div class="difference-grid">
                <div class="diff-headers">
                    <span>Frequency</span>
                    <span>Left</span>
                    <span>Right</span>
                    <span>Difference</span>
                </div>
    `;
    
    frequencies.forEach(freq => {
        const data = perFreq[freq];
        const absDiff = data.absolute_difference;
        const isSignificant = absDiff >= 15; // Highlight differences ≥15 dB
        
        html += `
            <div class="diff-row ${isSignificant ? 'significant-difference' : ''}">
                <span class="freq-label">${freq} Hz</span>
                <span class="left-val">${data.left_threshold.toFixed(1)}</span>
                <span class="right-val">${data.right_threshold.toFixed(1)}</span>
                <span class="diff-val ${isSignificant ? 'significant' : ''}">${absDiff.toFixed(1)} dB</span>
            </div>
        `;
    });
    
    html += `
            </div>
            <div class="difference-summary">
                <div class="summary-stats">
                    <span>Max: ${stats.max_absolute_difference.toFixed(1)} dB</span>
                    <span>Mean: ${stats.mean_absolute_difference.toFixed(1)} dB</span>
                    <span>Frequencies: ${stats.frequencies_compared}</span>
                </div>
                <p class="analysis-note">
                    <small>Objective measurements only. Values ≥15 dB highlighted for reference.</small>
                </p>
            </div>
        </div>
    `;
    
    return html;
}

async function analyzeCurrentThresholds(thresholds) {
    /*
     * Analyze interaural differences for current test results
     */
    if (!thresholds || !thresholds.left || !thresholds.right) {
        return null;
    }
    
    try {
        const response = await fetchWithTimeout('/user/interaural-analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                thresholds: thresholds,
                user_id: currentUser.isAuthenticated ? currentUser.id : null
            }),
            timeout: 5000
        });
        
        if (!response.ok) {
            throw new Error('Analysis request failed');
        }
        
        const analysis = await response.json();
        return analysis;
        
    } catch (error) {
        console.error('Interaural analysis error:', error);
        return null;
    }
}

function createInterauralDifferenceChart(analysisData, containerId) {
    /*
     * Create a Chart.js visualization of interaural differences
     */
    const container = document.getElementById(containerId);
    if (!container || !analysisData) return;
    
    const canvas = document.createElement('canvas');
    canvas.id = `${containerId}-chart`;
    container.innerHTML = '';
    container.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    const perFreq = analysisData.per_frequency_differences || analysisData.per_frequency;
    
    if (!perFreq) return;
    
    // Prepare data
    const frequencies = Object.keys(perFreq).map(f => parseInt(f)).sort((a, b) => a - b);
    const differences = frequencies.map(freq => perFreq[freq].absolute_difference);
    const signedDifferences = frequencies.map(freq => perFreq[freq].signed_difference);
    
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: frequencies.map(f => `${f} Hz`),
            datasets: [
                {
                    label: 'Absolute Difference (dB)',
                    data: differences,
                    backgroundColor: differences.map(d => d >= 15 ? 'rgba(245, 158, 11, 0.7)' : 'rgba(59, 130, 246, 0.7)'),
                    borderColor: differences.map(d => d >= 15 ? '#f59e0b' : '#3b82f6'),
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 20,
                    right: 20,
                    bottom: 20,
                    left: 20
                }
            },
            plugins: {
                title: {
                    display: true,
                    text: 'Interaural Threshold Differences by Frequency',
                    padding: { top: 10, bottom: 20 }
                },
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        afterLabel: function(context) {
                            const freq = frequencies[context.dataIndex];
                            const signed = signedDifferences[context.dataIndex];
                            const direction = signed > 0 ? 'Left ear worse' : signed < 0 ? 'Right ear worse' : 'Equal';
                            return `Signed difference: ${signed.toFixed(1)} dB (${direction})`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: { 
                        display: true, 
                        text: 'Frequency',
                        padding: { top: 10, bottom: 10 }
                    },
                    ticks: {
                        padding: 10
                    },
                    grid: {
                        display: true,
                        drawBorder: true
                    }
                },
                y: {
                    title: { 
                        display: true, 
                        text: 'Threshold Difference (dB)',
                        padding: { left: 10, right: 10 }
                    },
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return value + ' dB';
                        },
                        padding: 10
                    },
                    grid: {
                        display: true,
                        drawBorder: true
                    }
                }
            }
        }
    });
}

/* -----------------------
   Audio Debugging Utilities
   ----------------------- */

function debugAudioSettings() {
    console.log('=== Audio Debug Information ===');
    console.log('Calibration Volume:', calibrationVolume);
    console.log('Browser:', navigator.userAgent);
    console.log('Audio Context State:', audioContext ? audioContext.state : 'Not initialized');
    console.log('Audio Initialized:', audioInitialized);
    
    // Test if Web Audio API is available
    if (window.AudioContext || window.webkitAudioContext) {
        console.log('Web Audio API: Available');
    } else {
        console.log('Web Audio API: Not Available');
    }
    
    // Check if we're in a secure context (required for some audio features)
    console.log('Secure Context:', window.isSecureContext);
    console.log('Location:', window.location.href);
    console.log('Protocol:', window.location.protocol);
    
    return {
        calibrationVolume,
        userAgent: navigator.userAgent,
        audioSupport: !!(window.AudioContext || window.webkitAudioContext),
        secureContext: window.isSecureContext,
        audioContextState: audioContext ? audioContext.state : 'not-initialized',
        protocol: window.location.protocol
    };
}

// Test audio functionality
async function testAudio() {
    console.log('=== Testing Audio Functionality ===');
    
    // Initialize audio context
    await initializeAudioContext();
    
    console.log('Testing server-generated tone...');
    try {
        await playServerTone({ freq: 1000, duration: 0.5, volume: 0.8, channel: 'both' });
        console.log('✅ Server tone test passed');
    } catch (e) {
        console.error('❌ Server tone test failed:', e);
    }
    
    if (audioContext) {
        console.log('Testing Web Audio API tone...');
        try {
            await generateWebAudioTone(1000, 0.5, 0.3, 'both');
            console.log('✅ Web Audio API test passed');
        } catch (e) {
            console.error('❌ Web Audio API test failed:', e);
        }
    }
    
    console.log('Audio tests completed');
}

// Show audio error to user with troubleshooting options
function showAudioError(message) {
    // Remove any existing audio error notifications
    const existingErrors = document.querySelectorAll('.audio-error-notification');
    existingErrors.forEach(el => el.remove());
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'audio-error-notification';
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff6b6b;
        color: white;
        padding: 15px;
        border-radius: 8px;
        z-index: 10000;
        font-size: 14px;
        max-width: 350px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    errorDiv.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 8px;">🔊 Audio Issue Detected</div>
        <div style="margin-bottom: 10px;">${message}</div>
        <div style="font-size: 12px; margin-bottom: 10px;">
            <strong>Quick fixes:</strong><br>
            • Check volume is turned up<br>
            • Ensure headphones are connected<br>
            • Try refreshing the page<br>
            • Check browser audio permissions
        </div>
        <button onclick="this.parentElement.remove()" style="
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            margin-right: 8px;
        ">Dismiss</button>
        <button onclick="window.runAudioDiagnostics()" style="
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        ">Test Audio</button>
    `;
    
    document.body.appendChild(errorDiv);
    
    // Auto-dismiss after 8 seconds
    setTimeout(() => {
        if (errorDiv.parentNode) {
            errorDiv.parentNode.removeChild(errorDiv);
        }
    }, 8000);
}

// Run comprehensive audio diagnostics
async function runAudioDiagnostics() {
    console.log('🔊 Running Audio System Diagnostics...');
    
    const diagnostics = {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        isSecureContext: window.isSecureContext,
        protocol: window.location.protocol,
        hostname: window.location.hostname,
        audioContextSupport: !!(window.AudioContext || window.webkitAudioContext),
        htmlAudioSupport: !!window.Audio,
        tests: {}
    };
    
    // Test 1: Basic Audio Element Creation
    try {
        const testAudio = new Audio();
        diagnostics.tests.audioElementCreation = {
            success: true,
            canPlayType: {
                wav: testAudio.canPlayType('audio/wav'),
                mp3: testAudio.canPlayType('audio/mpeg'),
                ogg: testAudio.canPlayType('audio/ogg')
            }
        };
    } catch (e) {
        diagnostics.tests.audioElementCreation = { success: false, error: e.message };
    }
    
    // Test 2: Server Tone Endpoint Accessibility
    try {
        const response = await fetch('/tone?freq=1000&duration=0.1&volume=0.1&channel=both&test=1');
        diagnostics.tests.serverToneEndpoint = {
            success: response.ok,
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length')
        };
        
        if (response.ok) {
            const audioBlob = await response.blob();
            diagnostics.tests.serverToneEndpoint.blobSize = audioBlob.size;
        }
    } catch (e) {
        diagnostics.tests.serverToneEndpoint = { success: false, error: e.message };
    }
    
    // Test 3: Web Audio API Context
    try {
        await initializeAudioContext();
        diagnostics.tests.webAudioAPI = {
            success: !!audioContext,
            state: audioContext ? audioContext.state : 'unavailable',
            sampleRate: audioContext ? audioContext.sampleRate : null
        };
    } catch (e) {
        diagnostics.tests.webAudioAPI = { success: false, error: e.message };
    }
    
    // Test 4: Audio Playback Test (silent)
    try {
        const testResult = await testSilentAudioPlayback();
        diagnostics.tests.audioPlayback = testResult;
    } catch (e) {
        diagnostics.tests.audioPlayback = { success: false, error: e.message };
    }
    
    // Log comprehensive results
    console.log('🔊 Audio Diagnostics Complete:', diagnostics);
    
    // Show warning if critical issues detected
    const criticalIssues = [];
    if (!diagnostics.tests.serverToneEndpoint?.success) {
        criticalIssues.push('Server audio endpoint unavailable');
    }
    if (!diagnostics.tests.audioPlayback?.success) {
        criticalIssues.push('Audio playback blocked or failed');
    }
    if (!diagnostics.isSecureContext && diagnostics.protocol !== 'https:') {
        criticalIssues.push('Insecure context may limit audio features');
    }
    
    if (criticalIssues.length > 0) {
        console.warn('⚠️ Audio System Issues Detected:', criticalIssues);
        showAudioError(`Audio system issues detected: ${criticalIssues.join(', ')}. Please check browser settings.`);
    } else {
        console.log('✅ Audio system appears functional');
    }
    
    return diagnostics;
}

// Test silent audio playback to check for browser blocking
async function testSilentAudioPlayback() {
    return new Promise((resolve) => {
        const testAudio = new Audio();
        testAudio.volume = 0.01; // Very quiet
        testAudio.preload = 'auto';
        
        let resolved = false;
        const resolveOnce = (result) => {
            if (!resolved) {
                resolved = true;
                resolve(result);
            }
        };
        
        testAudio.oncanplay = () => {
            testAudio.play().then(() => {
                resolveOnce({ success: true, method: 'html_audio', canPlay: true });
            }).catch(err => {
                resolveOnce({ success: false, method: 'html_audio', error: err.message, canPlay: true });
            });
        };
        
        testAudio.onerror = (e) => {
            resolveOnce({ success: false, method: 'html_audio', error: 'Audio load error', canPlay: false });
        };
        
        // Set a simple data URL for a minimal WAV file
        testAudio.src = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT';
        
        // Fallback timeout
        setTimeout(() => {
            resolveOnce({ success: false, method: 'html_audio', error: 'Timeout', canPlay: false });
        }, 3000);
    });
}

// Add debug and test functions to global scope for console access
window.debugAudio = debugAudioSettings;
window.testAudio = testAudio;
window.runAudioDiagnostics = runAudioDiagnostics;

/* -----------------------
   Feedback System
   ----------------------- */

let currentSessionId = null;
let feedbackRatings = {
    test_clarity: null,
    audio_comfort: null,
    ease_of_use: null
};

function showFeedbackSection(sessionId) {
    currentSessionId = sessionId;
    const feedbackSection = document.getElementById('feedback-section');
    if (feedbackSection) {
        feedbackSection.classList.remove('hidden');
        feedbackSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    // Initialize feedback form
    initializeFeedbackForm();
}

function initializeFeedbackForm() {
    // Reset ratings
    feedbackRatings = {
        test_clarity: null,
        audio_comfort: null,
        ease_of_use: null
    };
    
    // Initialize star ratings
    const starRatings = document.querySelectorAll('.star-rating');
    starRatings.forEach(rating => {
        const stars = rating.querySelectorAll('.star');
        const ratingType = rating.dataset.rating;
        
        stars.forEach((star, index) => {
            star.classList.remove('active');
            
            // Click handler
            star.addEventListener('click', () => {
                const value = parseInt(star.dataset.value);
                feedbackRatings[ratingType] = value;
                
                // Update visual state
                stars.forEach((s, i) => {
                    s.classList.toggle('active', i < value);
                });
            });
            
            // Hover effects
            star.addEventListener('mouseenter', () => {
                const value = parseInt(star.dataset.value);
                stars.forEach((s, i) => {
                    s.classList.toggle('hover', i < value);
                });
            });
            
            star.addEventListener('mouseleave', () => {
                stars.forEach(s => s.classList.remove('hover'));
            });
        });
    });
    
    // Character counter for suggestions
    const suggestionsInput = document.getElementById('suggestions-input');
    const charCounter = document.getElementById('char-counter');
    
    if (suggestionsInput && charCounter) {
        suggestionsInput.addEventListener('input', () => {
            const length = suggestionsInput.value.length;
            charCounter.textContent = length;
            
            // Visual feedback for character limit
            if (length > 900) {
                charCounter.style.color = '#e74c3c';
            } else if (length > 800) {
                charCounter.style.color = '#f39c12';
            } else {
                charCounter.style.color = 'var(--text-muted)';
            }
        });
    }
    
    // Form submission
    const feedbackForm = document.getElementById('feedback-form');
    if (feedbackForm) {
        feedbackForm.addEventListener('submit', handleFeedbackSubmission);
    }
    
    // Skip button
    const skipButton = document.getElementById('skip-feedback-btn');
    if (skipButton) {
        skipButton.addEventListener('click', hideFeedbackSection);
    }
}

async function handleFeedbackSubmission(event) {
    event.preventDefault();
    
    const form = event.target;
    const submitButton = document.getElementById('submit-feedback-btn');
    const suggestionsText = document.getElementById('suggestions-input').value.trim();
    
    // Show loading state
    form.classList.add('submitting');
    if (submitButton) {
        submitButton.textContent = 'Submitting...';
        submitButton.disabled = true;
    }
    
    try {
        // Prepare feedback data
        const feedbackData = {
            session_id: currentSessionId,
            user_id: userId || null, // Allow anonymous feedback for guests
            test_clarity_rating: feedbackRatings.test_clarity,
            audio_comfort_rating: feedbackRatings.audio_comfort,
            ease_of_use_rating: feedbackRatings.ease_of_use,
            suggestions_text: suggestionsText || null
        };
        
        // Submit feedback
        const response = await fetchWithTimeout('/submit_feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feedbackData),
            timeout: 10000
        });
        
        if (response.ok) {
            const result = await response.json();
            showFeedbackSuccess();
            logDebug('Feedback submitted successfully');
        } else {
            throw new Error('Failed to submit feedback');
        }
        
    } catch (error) {
        console.error('Feedback submission error:', error);
        
        // Show error state
        form.classList.remove('submitting');
        if (submitButton) {
            submitButton.textContent = 'Try Again';
            submitButton.disabled = false;
        }
        
        // Show user-friendly error message
        showNotification('Failed to submit feedback. Please try again.', 'error');
    }
}

function showFeedbackSuccess() {
    const form = document.getElementById('feedback-form');
    const successDiv = document.getElementById('feedback-success');
    
    if (form && successDiv) {
        form.classList.add('submitted');
        successDiv.classList.remove('hidden');
        successDiv.classList.add('show');
        
        // Auto-hide feedback section after success
        setTimeout(() => {
            hideFeedbackSection();
        }, 3000);
    }
}

function hideFeedbackSection() {
    const feedbackSection = document.getElementById('feedback-section');
    if (feedbackSection) {
        feedbackSection.classList.add('hidden');
    }
    
    // Reset form state
    const form = document.getElementById('feedback-form');
    const successDiv = document.getElementById('feedback-success');
    
    if (form) {
        form.classList.remove('submitting', 'submitted');
        form.reset();
    }
    
    if (successDiv) {
        successDiv.classList.remove('show');
        successDiv.classList.add('hidden');
    }
    
    // Reset submit button
    const submitButton = document.getElementById('submit-feedback-btn');
    if (submitButton) {
        submitButton.textContent = 'Submit Feedback';
        submitButton.disabled = false;
    }
    
    // Reset ratings
    feedbackRatings = {
        test_clarity: null,
        audio_comfort: null,
        ease_of_use: null
    };
    
    // Reset star visuals
    const stars = document.querySelectorAll('.star');
    stars.forEach(star => {
        star.classList.remove('active', 'hover');
    });
    
    // Reset character counter
    const charCounter = document.getElementById('char-counter');
    if (charCounter) {
        charCounter.textContent = '0';
        charCounter.style.color = 'var(--text-muted)';
    }
}

function showNotification(message, type = 'info') {
    // Simple notification system
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 1rem 1.5rem;
        background: ${type === 'error' ? '#e74c3c' : '#2ecc71'};
        color: white;
        border-radius: 6px;
        z-index: 10000;
        animation: slideInRight 0.3s ease-out;
    `;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease-in';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Add CSS animations for notifications
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
    @keyframes slideInRight {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOutRight {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(notificationStyles);