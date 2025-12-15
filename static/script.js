// script.js (fixed scrolling + cross-browser timeouts + small UI fixes)
let currentScreen = 'login';
const testFrequencies = [5000, 4000, 2000, 1000, 500, 250];
let userId = null;
let calibrationVolume = 0.3;
const debugMode = true;
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

document.addEventListener('DOMContentLoaded', () => {
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
        userId = result.user_id; // Internal DB ID associated with Supabase ID

        // Update local vars
        if (result.name) userName = result.name;
        if (result.surname) userSurname = result.surname;
        if (result.age_group) userAgeGroup = result.age_group;
        if (result.gender) userGender = result.gender;

        logDebug(`User synced: SupabaseID=${supabaseId} -> LocalID=${userId} Name=${userName}`);
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
    userName = guestName;
    userSurname = "";

    toggleLoader(true);
    try {
        const response = await fetchWithTimeout('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: guestName, surname: 'Guest', age_group: 'adult' }), // No Supabase ID
            timeout: 6000
        });
        const result = await response.json();
        userId = result.user_id;
        toggleLoader(false);
        showScreen('welcome');
    } catch (e) {
        toggleLoader(false);
        alert("Guest login failed");
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
    userId = null;
    userName = '';
    userSurname = '';
    calibrationVolume = 0.3;
    const slider = document.getElementById('volume-slider');
    if (slider) slider.value = 0.3;
    showScreen('login');
    logDebug('Test restarted');
}
