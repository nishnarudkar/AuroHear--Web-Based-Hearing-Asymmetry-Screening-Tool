// script.js - Enhanced authentication and user management
let currentScreen = 'login';
const testFrequencies = [5000, 4000, 2000, 1000, 500, 250];
let userId = null;
let calibrationVolume = 0.3;
const debugMode = true;

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
        if (supabase) {
            const { data: { session } } = await supabase.auth.getSession();
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
    }
    
    logDebug(`UI updated for ${isAuthenticated ? 'authenticated' : 'guest'} user`);
}

/* -----------------------
   UI helpers
   ----------------------- */
function showScreen(screenId) {
    const scrollableScreens = ['testing', 'results']; // screens that should scroll
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
function playServerTone(params) {
    const url = new URL('/tone', window.location);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v.toString()));
    logDebug(`Playing tone: ${JSON.stringify(params)}`);
    return new Promise((resolve) => {
        const audio = new Audio(url);
        audio.volume = Math.max(0, Math.min(1, calibrationVolume * (params.volume ?? 1)));
        audio.onended = () => {
            logDebug('Audio playback ended');
            resolve();
        };
        const baseDuration = parseFloat(params.duration || 0.35) * 1000;
        const fallbackMs = baseDuration + (params.freq <= 500 ? 300 : 150);
        const fallback = setTimeout(() => {
            try { audio.pause(); } catch (e) { }
            logDebug('Audio playback fallback triggered');
            resolve();
        }, fallbackMs + 200);

        audio.play().then(() => {
            logDebug('Audio playback started');
        }).catch(err => {
            console.error('Audio playback error:', err);
            clearTimeout(fallback);
            // resolve after fallback to keep flow moving
            setTimeout(() => resolve(), fallbackMs + 200);
        });
    });
}

async function playTestTone(freq, channel, levelDb) {
    // levelDb -> relative amplitude mapping (preserve original calculation)
    const amplitude = Math.pow(10, (levelDb - 40) / 20);
    const duration = 0.35;
    setActiveEar(channel);
    await playServerTone({ freq: freq, duration: duration, volume: amplitude, channel: channel });
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
    setActiveEar(channel);
    playServerTone({ freq: 1000, duration: 0.7, volume: 0.6, channel: channel })
        .then(() => setTimeout(() => {
            if (status) status.textContent = '';
            setActiveEar(null);
        }, 400));
}

/* -----------------------
   Event listeners (wiring)
   ----------------------- */
/* -----------------------
   Supabase & Auth Logic
   ----------------------- */
let supabase = null;
if (window.SUPABASE_URL && window.SUPABASE_KEY) {
    try {
        supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
        logDebug('Supabase client initialized');
    } catch (e) {
        console.error('Supabase init error (check CDN/Keys):', e);
    }
} else {
    console.warn('Supabase URL/Key missing.');
}

let isSignUp = false; // default mode: Sign In

document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication status on app load
    const isAuthenticated = await checkAuthenticationStatus();
    updateUIForAuthState();
    
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
    if (authForm) authForm.addEventListener('submit', onAuthSubmit);

    // Guest Bypass
    const bypassBtn = document.getElementById('bypass-btn');
    if (bypassBtn) bypassBtn.addEventListener('click', () => {
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
    if (startBtn) startBtn.addEventListener('click', () => showScreen('consent'));

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
    if (playToneBtn) playToneBtn.addEventListener('click', () => playServerTone({ freq: 1000, duration: 1.0, volume: 1.0, channel: 'both' }));

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

    setActiveEar(null);
});

async function onAuthSubmit(e) {
    e.preventDefault();
    if (!supabase) {
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
            const { data, error } = await supabase.auth.signUp({
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
            const { data, error } = await supabase.auth.signInWithPassword({
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
   Start test / run test
   ----------------------- */
async function startHearingTest() {
    if (!userId) {
        alert('User ID is missing. Please restart the test.');
        showScreen('login');
        return;
    }
    logDebug(`Starting test for user ID=${userId}`);
    showScreen('testing');
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
        await runTest(data);
    } catch (err) {
        toggleLoader(false);
        console.error('Start test error:', err);
        alert(`Failed to start test: ${err.message}. Please try again.`);
        showScreen('welcome');
    }
}

async function runTest(testData) {
    logDebug(`Running test: ${JSON.stringify(testData)}`);
    document.getElementById('progress-bar').value = testData.progress ?? 0;
    document.getElementById('progress-label').textContent = `${Math.round(testData.progress ?? 0)}%`;
    document.getElementById('status-label').textContent = `Testing ${testData.freq} Hz`;
    document.getElementById('test-info').textContent = `Test ${testData.test_number}/${testData.total_tests} ⚡`;

    const currentEar = testData.ear;
    setActiveEar(currentEar);

    const responseStatus = document.getElementById('response-status');
    if (responseStatus) responseStatus.textContent = 'Playing tone...';
    const yesBtn = document.getElementById('yes-btn');
    const noBtn = document.getElementById('no-btn');
    if (yesBtn) yesBtn.disabled = true;
    if (noBtn) noBtn.disabled = true;

    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
        try {
            await playTestTone(testData.freq, testData.ear, testData.level ?? 40);
            if (responseStatus) responseStatus.textContent =
                `Freq: ${testData.freq} Hz | Level: ${testData.level ?? 40} dB HL — Did you hear it?`;
            if (yesBtn) yesBtn.disabled = false;
            if (noBtn) noBtn.disabled = false;
            logDebug('Tone played, buttons enabled');
            return;
        } catch (err) {
            attempts++;
            console.error(`Tone playback error (attempt ${attempts}):`, err);
            if (attempts === maxAttempts) {
                console.error('Max playback attempts reached');
                alert('Error playing tone after multiple attempts. Please try again or restart the test.');
                if (responseStatus) responseStatus.textContent = 'Error playing tone. Please try again.';
                if (yesBtn) yesBtn.disabled = false;
                if (noBtn) noBtn.disabled = false;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
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

    logDebug(`Submitting response: heard=${heard}`);
    const responseStatus = document.getElementById('response-status');
    if (responseStatus) responseStatus.textContent = 'Submitting response...';
    const yesBtn = document.getElementById('yes-btn');
    const noBtn = document.getElementById('no-btn');
    if (yesBtn) yesBtn.disabled = true;
    if (noBtn) noBtn.disabled = true;

    toggleLoader(true);
    try {
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
            showResultsScreen(testData);
        } else {
            setTimeout(() => runTest(testData), 150);
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
            plugins: {
                legend: { position: 'top' },
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
                    title: { display: true, text: 'Frequency (Hz)' },
                    ticks: {
                        callback: function (val, index, ticks) {
                            return Number(val).toFixed(0);
                        }
                    }
                },
                y: {
                    reverse: true,
                    title: { display: true, text: 'Threshold (dB HL)' },
                    min: -10,
                    max: 40
                }
            },
            hoverRadius: 8,
            hoverBorderWidth: 2
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

    const recEl = document.getElementById('recommendation');
    if (recEl) recEl.textContent = asymmetryDetected
        ? 'Recommendation: Consult an audiologist for follow-up.'
        : 'This is a demo — if you have concerns, consult a professional.';

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
    
    // Reset legacy variables
    userId = null;
    userName = '';
    userSurname = '';
    userGender = '';
    userAgeGroup = '';
    
    calibrationVolume = 0.3;
    const slider = document.getElementById('volume-slider');
    if (slider) slider.value = 0.3;
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
    
    // Add statistics header
    const statsHeader = document.createElement('div');
    statsHeader.className = 'history-stats';
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
            plugins: {
                title: {
                    display: true,
                    text: 'Historical Audiogram Overlay',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
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
                        font: { weight: 'bold' }
                    },
                    ticks: {
                        callback: function(val, index, ticks) {
                            return Number(val).toFixed(0);
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    reverse: true,
                    title: { 
                        display: true, 
                        text: 'Threshold (dB HL)',
                        font: { weight: 'bold' }
                    },
                    min: -10,
                    max: 40,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
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
