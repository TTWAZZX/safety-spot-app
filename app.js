// ===============================================================
//  APP CONFIGURATION
// ===============================================================
const API_BASE_URL = "https://shesafety-spot-appbackend.onrender.com";
const LIFF_ID = "2007053300-9xLKdwZp";

// แผนก / หน่วยงานในบริษัท
const DEPARTMENTS = [
    'ACCOUNTING SEC.',
    'COSTING & FIX ASSET SEC.',
    'CUSTOMER SERVICE SEC.',
    'DIRECTOR DEPT.',
    'CIC DIV.',
    'ENGINEERING 1 SEC.',
    'ENGINEERING 2 SEC.',
    'FINANCIAL SEC.',
    'GOVERMENT RELATION SEC.',
    'HORORARY PRESIDENT DEPT.',
    'HUMAN RESOURCES DEVELOPMENT SEC.',
    'HUMAN RESOURCES MANAGEMENT SEC.',
    'INFORMATION TECHNOLOGY SEC.',
    'MAINTENANCE SEC.',
    'MARKETING 1 SEC.',
    'MARKETING 2 SEC.',
    'MARKETING 3 SEC.',
    'MARKETING 4 SEC.',
    'MARKETING 5 SEC.',
    'MATERIAL CONTROL SEC.',
    'OUT SOURCE SEC.',
    'PRODUCTION 1 SEC.',
    'PRODUCTION 2 SEC.',
    'PRODUCTION CONTROL SEC.',
    'PRODUCTION ENGINEERING SEC.',
    'PURCHASING DIRECT SEC.',
    'PURCHASING INDIRECT SEC.',
    'QUALITY ASSURANCE SEC.',
    'QUALITY CONTROL SEC.',
    'RESEARCH & DEVELOPMENT SEC.',
    'SAFETY HEALTH & ENVIRONMENT SEC.',
    'SYSTEM ENGINEERING SEC.',
    'TSH CENTER',
    'WAREHOUSE SEC.',
];

// สร้าง <option> elements สำหรับ department select
function buildDeptOptions(selectedVal = '') {
    return DEPARTMENTS.map(d =>
        `<option value="${d}"${d === selectedVal ? ' selected' : ''}>${d}</option>`
    ).join('');
}

// Blocking prompt: บังคับเลือกแผนกก่อนใช้งาน
async function promptSelectDepartment(userData) {
    const selectOptions = DEPARTMENTS.map(d => `<option value="${d}">${d}</option>`).join('');
    let confirmed = false;
    while (!confirmed) {
        const { value: dept, isConfirmed } = await Swal.fire({
            title: 'กรุณาเลือกแผนก / หน่วยงาน',
            html: `
                <p class="text-muted mb-3" style="font-size:0.9rem;">
                    ระบุแผนกของคุณเพื่อเริ่มใช้งาน Safety Spot<br>
                    <strong>จำเป็นต้องเลือกก่อนดำเนินการต่อ</strong>
                </p>
                <select id="swal-dept-select" class="swal2-input" style="width:100%;margin:0;padding:8px 12px;height:auto;">
                    <option value="" disabled selected>— เลือกแผนก —</option>
                    ${selectOptions}
                </select>`,
            confirmButtonText: '<i class="fas fa-check me-1"></i> ยืนยัน',
            confirmButtonColor: '#06C755',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showCancelButton: false,
            preConfirm: () => {
                const val = document.getElementById('swal-dept-select').value;
                if (!val) {
                    Swal.showValidationMessage('กรุณาเลือกแผนกก่อนยืนยัน');
                    return false;
                }
                return val;
            }
        });
        if (isConfirmed && dept) {
            try {
                await callApi('/api/user/update-department', { lineUserId: userData.lineUserId, department: dept }, 'POST');
                AppState.currentUser.department = dept;
                confirmed = true;
            } catch(e) {
                await Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: e.message });
            }
        }
    }
}

// ตัวแปร global ฝั่ง frontend
let adminSelectedUserId = null;   // เก็บ lineUserId ของ user ที่เปิด modal อยู่ตอนนี้

// Global variables
const AppState = {
    lineProfile: null,
    currentUser: null,
    allModals: {},
    reportsChart: null,
    leaderboard: { currentPage: 1, hasMore: true },
    adminUsers: { currentPage: 1, hasMore: true, currentSearch: '', currentSort: 'score' },
    // Cached data
    _cachedQuestions: null,
    _cachedCards: null,
    _cachedBadges: null,
    _cachedAdminUsers: null,
    _lastCards: null,
    // Session flags
    _streakWarningShown: false,
};

// --- UTILS: HAPTIC FEEDBACK ---
function triggerHaptic(pattern = 'medium') {
    // เช็คว่ามือถือรองรับการสั่นไหม (Android ได้เกือบหมด, iOS ได้บางเวอร์ชัน)
    if (navigator.vibrate) {
        try {
            if (pattern === 'light') navigator.vibrate(15); // สั่นเบา (กดปุ่ม)
            else if (pattern === 'medium') navigator.vibrate(40); // สั่นกลาง (สำเร็จ)
            else if (pattern === 'heavy') navigator.vibrate([50, 30, 50, 30, 100]); // สั่นแรง (ได้รางวัลใหญ่/เตือน)
        } catch(e) { /* Ignore error on some devices */ }
    }
}

// ===============================================================
//  INITIALIZATION
// ===============================================================
$(document).ready(function() {
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    $('body').on('click', function () {
        $('[data-bs-toggle="tooltip"]').tooltip('hide');
    });

    initializeAllModals();
    // Populate department dropdowns
    $('#reg-department').append(buildDeptOptions());
    $('#admin-edit-department').append(buildDeptOptions());
    initializeApp();
    bindStaticEventListeners();
    bindAdminTabEventListeners();
});

// ในไฟล์ app.js ค้นหา function initializeAllModals()
function initializeAllModals() {
    // เพิ่ม 'quiz' เข้าไปใน array นี้ครับ
    const modalIds = ['submission', 'admin-reports', 'admin-activities', 'activity-form', 'activity-detail', 'admin-stats', 'admin-manage-badges', 'badge-form', 'user-details', 'notification', 'quiz', 'admin-analytics', 'admin-dept', 'admin-export', 'admin-audit'];
    
    modalIds.forEach(id => {
        const modalElement = document.getElementById(`${id}-modal`);
        if (modalElement) {
            AppState.allModals[id] = new bootstrap.Modal(modalElement);
        }
    });
}

async function initializeApp() {
    try {
        $('#loading-status-text').text('กำลังเชื่อมต่อกับ LINE');
        await liff.init({ liffId: LIFF_ID });

        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }

        $('#loading-status-text').text('กำลังดึงข้อมูลโปรไฟล์');
        const lineProfile = await liff.getProfile();
        AppState.lineProfile = lineProfile;

        // --- ส่วนที่เพิ่มเข้ามา ---
        // highlight-start
        // "ยิงแล้วลืม" (Fire and forget) ส่งโปรไฟล์ไปอัปเดตที่ Backend
        // เราไม่ต้องรอให้เสร็จก็สามารถทำงานต่อไปได้เลย
        callApi('/api/user/refresh-profile', {
            lineUserId: lineProfile.userId,
            displayName: lineProfile.displayName,
            pictureUrl: lineProfile.pictureUrl
        }, 'POST').catch(err => console.error("Profile refresh failed:", err));
        // highlight-end

        $('#loading-status-text').text('กำลังตรวจสอบการลงทะเบียน');
        const result = await callApi('/api/user/profile', { lineUserId: lineProfile.userId });

        if (result.registered) {
            await showMainApp(result.user);
        } else {
            $('#loading-overlay').addClass('d-none');
            $('#registration-page').show();
        }
    } catch (error) {
        console.error("Initialization failed:", error);
        $('#loading-status-text').text('เกิดข้อผิดพลาด');
        $('#loading-sub-text').text('ไม่สามารถเริ่มต้นแอปพลิเคชันได้ กรุณาลองใหม่อีกครั้ง').addClass('text-danger');
        $('.spinner-border').hide();
    }
}

async function showMainApp(userData) {
    try {
        // ใช้รูป LINE profile ล่าสุดทันที (ไม่รอให้ refresh-profile sync กับ DB ก่อน)
        if (AppState.lineProfile && AppState.lineProfile.pictureUrl) {
            userData.pictureUrl = AppState.lineProfile.pictureUrl;
        }
        AppState.currentUser = userData;
        updateUserInfoUI(AppState.currentUser);

        // Check streak milestone celebration
        checkStreakMilestone(userData.currentStreak);

        // ---------------------------
        // แสดงเมนู Admin เฉพาะแอดมิน
        // ---------------------------
        if (userData && userData.isAdmin) {
            $('#admin-nav-item').show();
            bindAdminEventListeners();
        } else {
            $('#admin-nav-item').hide();
        }

        // โหลดกิจกรรม
        const activities = await callApi('/api/activities', {
            lineUserId: AppState.lineProfile.userId
        });
        displayActivitiesUI(activities, 'all-activities-list');

        // โหลด Home Dashboard (profile card + stats + dept leaderboard + recent activities)
        loadHomeDashboard(activities);

        // ปิด loading overlay ก่อน แล้วค่อยแสดง app
        $('#loading-overlay').addClass('d-none');
        $('#main-app').fadeIn();

        // Pull To Refresh
        PullToRefresh.init({
            mainElement: 'body',
            onRefresh: async function(done) {
                await refreshHomePageData();
                done();
            },
            iconArrow: '<i class="fas fa-arrow-down"></i>',
            iconRefreshing: '<div class="spinner-border spinner-border-sm text-success"></div>',
            distThreshold: 80,
            distMax: 100
        });

        checkUnreadNotifications();

        // ถ้าผู้ใช้ยังไม่มีแผนก → บังคับเลือกหลัง app แสดงแล้ว (ต้องไม่ชนกับ loading overlay)
        if (!userData.department) {
            await promptSelectDepartment(userData);
        }

    } catch (error) {
        console.error("Error during showMainApp:", error);
        showError('เกิดข้อผิดพลาดในการโหลดข้อมูลบางส่วน');
        $('#main-app').fadeIn();
    } finally {
        $('#loading-overlay').addClass('d-none');
    }
}

// ===============================================================
//  API CALLER & UPLOADER
// ===============================================================
async function callApi(endpoint, payload = {}, method = 'GET') {
    let url = API_BASE_URL + endpoint;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };

    if (AppState.lineProfile && AppState.lineProfile.userId) {
    payload.requesterId = AppState.lineProfile.userId;
}

    if (method.toUpperCase() === 'GET' && Object.keys(payload).length > 0) {
        const params = new URLSearchParams(payload).toString();
        url += '?' + params;
    } else if (method.toUpperCase() !== 'GET') {
        options.body = JSON.stringify(payload);
    }

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorResult = await response.json().catch(() => ({ message: 'API request failed with status ' + response.status }));
            throw new Error(errorResult.message);
        }
        const result = await response.json();
        if (result.status === 'error') {
            throw new Error(result.message);
        }
        return result.data;
    } catch (error) {
        console.error(`API Error at ${endpoint}:`, error);
        throw error;
    }
}

// === Add: lightweight in-browser resize (no external libs) ===
async function resizeImageFile(file, maxDim = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return new File([blob], 'upload.jpg', { type: 'image/jpeg' });
}

// === Replace your uploadImage(file) with this version ===
async function uploadImage(file) {
  // 1) shrink on client first
  const optimized = await resizeImageFile(file, 1600, 0.8);

  // 2) upload via existing backend
  const formData = new FormData();
  formData.append('image', optimized);
  if (AppState.lineProfile && AppState.lineProfile.userId) {
    formData.append('lineUserId', AppState.lineProfile.userId);
  }

  const response = await fetch(`${API_BASE_URL}/api/upload`, { method: 'POST', body: formData });
  if (!response.ok) {
    const errorResult = await response.json().catch(() => ({ message: 'Image upload failed with status ' + response.status }));
    throw new Error(errorResult.message);
  }
  const result = await response.json();
  if (result.status === 'success') return result.data.imageUrl;
  throw new Error(result.message || 'Failed to get image URL from server.');
}

// === Add: Helper to inject Cloudinary delivery transforms ===
function optimizeCloudinaryUrl(url, { w = 800, q = 'auto:eco', f = 'auto' } = {}) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('res.cloudinary.com') && u.pathname.includes('/upload/')) {
      const parts = u.pathname.split('/upload/');
      // insert transforms at .../upload/<TRANSFORMS>/...
      u.pathname = parts[0] + '/upload/' + `f_${f},q_${q},w_${w}/` + parts[1];
      return u.toString();
    }
  } catch (e) {}
  return url;
}

// === Replace your original getFullImageUrl with this version ===
function getFullImageUrl(path, opts = {}) {
  const placeholder = 'https://placehold.co/600x400/e9ecef/6c757d?text=Image';
  if (!path) return placeholder;

  // If it's already a full URL
  if (path.startsWith('http://') || path.startsWith('https://')) {
    // enforce Cloudinary transforms when applicable
    return optimizeCloudinaryUrl(path, opts);
  }
  // local uploads
  return `${API_BASE_URL}/uploads/${path}`;
}

// ===============================================================
//  UI RENDERING FUNCTIONS
// ===============================================================
// อัปเดตเหรียญทุกจุดพร้อมกัน (HUD + Profile page + AppState)
function syncCoins(amount) {
    const n = Number(amount) || 0;
    $('#coin-display').text(n.toLocaleString());
    $('#profile-page-coins').text(n.toLocaleString());
    if (AppState.currentUser) AppState.currentUser.coinBalance = n;
}

function updateUserInfoUI(user) {
    $('#user-profile-pic, #profile-page-pic').attr('src', user.pictureUrl || 'https://placehold.co/80x80');
    $('#user-display-name, #profile-page-name').text(user.fullName);
    $('#user-employee-id').text(`รหัส: ${user.employeeId}`);
    $('#profile-page-employee-id').text(`รหัสพนักงาน: ${user.employeeId}`);
    $('#user-score, #profile-page-score').text(user.totalScore);
    $('#profile-page-coins').text(user.coinBalance || 0);
    $('#profile-page-streak').text((user.currentStreak || 0) + ' วัน');
    // Home dashboard stats
    $('#home-coins-display').text((user.coinBalance || 0).toLocaleString());
    $('#home-streak-display').text(user.currentStreak || 0);
    $('#home-dept-name').text(user.department || 'ยังไม่ระบุแผนก');
    // Percentile chip
    if (user.percentile !== undefined && user.percentile !== null) {
        const pct = user.percentile;
        const chip = $('#home-percentile-label');
        chip.text(`Top ${pct}%`).removeClass('d-none');
        chip.removeClass('pct-top pct-mid pct-low');
        if (pct <= 10) chip.addClass('pct-top');
        else if (pct <= 50) chip.addClass('pct-mid');
        else chip.addClass('pct-low');
    }
    // completion % จะถูกอัปเดตใน loadGameDashboard() หลังโหลดการ์ด
}

// ===============================================================
//  CONFETTI CELEBRATION
// ===============================================================
function fireConfetti(type = 'default') {
    if (typeof confetti !== 'function') return;
    if (type === 'big') {
        // Full celebration: 3 bursts
        const burst = () => confetti({
            particleCount: 120,
            spread: 80,
            origin: { y: 0.6 },
            colors: ['#06C755', '#FFD700', '#FF6B6B', '#4DA6FF', '#FF9F43']
        });
        burst();
        setTimeout(burst, 350);
        setTimeout(burst, 700);
    } else if (type === 'streak') {
        confetti({ particleCount: 80, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#06C755', '#FFD700'] });
        confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#06C755', '#FFD700'] });
    } else {
        confetti({ particleCount: 60, spread: 60, origin: { y: 0.65 } });
    }
}

// ===============================================================
//  STREAK MILESTONE CHECK
// ===============================================================
function checkStreakMilestone(streak) {
    if (!streak || streak < 7) return;
    const milestones = [7, 30, 60, 100];
    const hit = milestones.filter(m => streak >= m).pop();
    if (!hit) return;
    const key = `streak_milestone_${hit}_shown`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');

    const labels = { 7: '7 วัน', 30: '1 เดือน', 60: '2 เดือน', 100: '100 วัน' };
    const icons  = { 7: '🔥', 30: '⭐', 60: '🏆', 100: '👑' };
    setTimeout(() => {
        fireConfetti('streak');
        Swal.fire({
            title: `${icons[hit]} Streak ${labels[hit]}!`,
            html: `<p class="mb-0">คุณ Login ต่อเนื่องมาถึง <strong>${hit} วัน</strong> แล้ว!<br>ยอดเยี่ยมมาก ขอบคุณที่ใส่ใจความปลอดภัย</p>`,
            icon: 'success',
            confirmButtonColor: '#06C755',
            confirmButtonText: 'เยี่ยมมาก! 🎉',
            timer: 8000,
            timerProgressBar: true
        });
    }, 1200);
}

// ===============================================================
//  SOCIAL FEED
// ===============================================================
async function loadSocialFeed() {
    const container = $('#home-social-feed');
    try {
        const items = await callApi('/api/social-feed');
        if (!items || !items.length) {
            container.html('<div class="empty-state-small"><i class="fas fa-rss"></i><p>ยังไม่มีความเคลื่อนไหว</p></div>');
            return;
        }
        container.html(items.map(item => {
            const timeAgo = formatTimeAgo(item.createdAt);
            const pic = item.pictureUrl || 'https://placehold.co/36x36';
            return `<div class="feed-item">
                <img src="${pic}" class="feed-avatar" onerror="this.onerror=null;this.src='https://placehold.co/36x36'">
                <div class="feed-body">
                    <span class="feed-name">${sanitizeHTML(item.fullName || '')}</span>
                    <span class="feed-action"> ร่วมกิจกรรม </span>
                    <span class="feed-act">${sanitizeHTML(item.activityTitle || '')}</span>
                    <div class="feed-time">${timeAgo}</div>
                </div>
            </div>`;
        }).join(''));
    } catch (e) {
        container.html('<div class="empty-state-small"><i class="fas fa-wifi-slash"></i><p>โหลดไม่ได้</p></div>');
    }
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'เมื่อกี้';
    if (diff < 3600) return `${Math.floor(diff / 60)} นาทีที่แล้ว`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ชั่วโมงที่แล้ว`;
    return `${Math.floor(diff / 86400)} วันที่แล้ว`;
}

async function loadHomeDashboard(activities) {
    // อัปเดต profile fields จาก AppState ที่มีอยู่แล้ว
    if (AppState.currentUser) {
        updateUserInfoUI(AppState.currentUser);
    }

    // โหลด Department Leaderboard
    const container = $('#home-dept-leaderboard');
    try {
        const rows = await callApi('/api/department-leaderboard');
        if (!rows || !rows.length) {
            container.html('<p class="text-muted text-center small py-2">ยังไม่มีข้อมูลแผนก</p>');
        } else {
            const myDept = AppState.currentUser ? AppState.currentUser.department : '';
            const myRank = rows.findIndex(r => r.department === myDept);
            if (myRank >= 0) {
                $('#home-dept-rank-label').text(`แผนกคุณ: อันดับ ${myRank + 1} / ${rows.length}`);
            }
            const medals = ['🥇', '🥈', '🥉'];
            container.html(rows.map((r, i) => {
                const isMe = r.department === myDept;
                return `<div class="home-dept-row ${isMe ? 'home-dept-row-mine' : ''}">
                    <span class="home-dept-rank">${medals[i] || (i + 1)}</span>
                    <span class="home-dept-name-text flex-grow-1 text-truncate">${sanitizeHTML(r.department)}</span>
                    <span class="home-dept-score">${r.avgScore} <small class="text-muted">เฉลี่ย</small></span>
                </div>`;
            }).join(''));
        }
    } catch (e) {
        container.html('<p class="text-muted text-center small py-2">โหลดไม่ได้</p>');
    }

    // Render กิจกรรมล่าสุด (compact card สูงสุด 3 รายการ)
    const actList = $('#home-activities-list');
    const list = activities && activities.length ? activities : AppState._lastActivities;
    if (list && list.length) {
        AppState._lastActivities = list;
        const recent = list.slice(0, 3);
        actList.html(recent.map(act => {
            const done = act.userHasSubmitted;
            const countText = act.submissionCount > 0 ? `<span class="text-muted small"><i class="fas fa-users me-1"></i>${act.submissionCount} คนร่วม</span>` : '';
            return `<div class="home-act-card mb-2 ${done ? 'home-act-card-done' : ''}"
                        onclick="${done ? '' : `openActivitySubmission('${act.activityId}','${sanitizeHTML(act.title)}',${!act.description.includes('[no-image]')})`}"
                        style="cursor:${done ? 'default' : 'pointer'}">
                <img src="${getFullImageUrl(act.imageUrl, { w: 200 })}" class="home-act-thumb"
                     onerror="this.onerror=null;this.src='https://placehold.co/80x80/e9ecef/6c757d?text=?'">
                <div class="home-act-info">
                    <div class="home-act-title">${sanitizeHTML(act.title)}</div>
                    <div class="d-flex align-items-center gap-2 mt-1">${countText}</div>
                </div>
                <div class="home-act-status">
                    ${done
                        ? '<span class="badge bg-success"><i class="fas fa-check"></i> ส่งแล้ว</span>'
                        : '<span class="badge bg-primary">เข้าร่วม</span>'}
                </div>
            </div>`;
        }).join(''));
    } else {
        actList.html(`<div class="empty-state-small"><i class="fas fa-clipboard-list"></i><p>ยังไม่มีกิจกรรม</p></div>`);
    }

    // Load social feed
    loadSocialFeed();

    // Show safety tip
    initSafetyTip();
}

function initSafetyTip() {
    const tips = [
        'สวมอุปกรณ์ PPE ทุกครั้งก่อนเข้าพื้นที่อันตราย',
        'ตรวจสอบสภาพเครื่องมือก่อนใช้งานทุกครั้ง',
        'อย่าเดินในเส้นทางที่กำหนดสำหรับยานพาหนะ',
        'รายงานความเสี่ยงทันทีที่พบ อย่ารอให้เกิดอุบัติเหตุก่อน',
        'ล้างมือก่อนและหลังสัมผัสสารเคมี',
        'ตรวจสอบป้ายเตือนและปฏิบัติตามอย่างเคร่งครัด',
        'อย่าทำงานคนเดียวในพื้นที่อันตราย',
        'รู้ตำแหน่งถังดับเพลิงและทางหนีไฟเสมอ',
        'ยกของหนักด้วยท่าทางที่ถูกต้อง งอเข่าไม่ใช่หลัง',
        'ห้ามใช้โทรศัพท์ขณะควบคุมเครื่องจักร',
        'ตรวจสอบ Lock Out/Tag Out ก่อนซ่อมบำรุงเครื่องจักร',
        'สื่อสารชัดเจนเมื่อทำงานเป็นทีมในพื้นที่เสี่ยง',
        'รักษาความสะอาดและความเป็นระเบียบในพื้นที่ทำงาน',
        'ตรวจสอบสายไฟและอุปกรณ์ไฟฟ้าก่อนใช้งาน',
        'อย่าวิ่งในโรงงาน เดินอย่างระมัดระวัง',
        'แจ้งหัวหน้าทันทีหากรู้สึกไม่สบายขณะทำงาน',
        'ใช้สารเคมีตามปริมาณที่กำหนด อย่าเกินขนาด',
        'สวมสายรัดนิรภัยเมื่อทำงานบนที่สูงเกิน 2 เมตร',
        'อ่านและทำความเข้าใจ SDS ก่อนใช้สารเคมีใหม่',
        'ฝึกซ้อมแผนฉุกเฉินสม่ำเสมอ เพื่อพร้อมรับสถานการณ์จริง',
        'ตรวจสอบความพร้อมของอุปกรณ์ปฐมพยาบาลในพื้นที่ทำงาน',
        'รักษาระยะห่างที่ปลอดภัยจากเครื่องจักรที่กำลังทำงาน',
        'ห้ามดัดแปลงอุปกรณ์ความปลอดภัยโดยไม่ได้รับอนุญาต',
        'รายงาน Near Miss ทุกครั้ง แม้จะไม่มีใครได้รับบาดเจ็บ',
        'ดูแลสุขภาพให้แข็งแรง คนที่เหนื่อยล้าเสี่ยงอุบัติเหตุสูงกว่า',
        'ตรวจสอบอุณหภูมิและความชื้นในพื้นที่ทำงานให้อยู่ในเกณฑ์',
        'ใช้เส้นทางที่กำหนดเท่านั้นในการเคลื่อนย้ายสินค้า',
        'ปิดฝาครอบเครื่องจักรทุกครั้งหลังซ่อมบำรุงเสร็จ',
        'แจ้งเตือนเพื่อนร่วมงานเมื่อพบความเสี่ยง ความปลอดภัยเป็นของทุกคน',
        'อย่าข้ามขั้นตอนเพื่อความเร็ว ความปลอดภัยสำคัญกว่า',
    ];
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const tip = tips[dayOfYear % tips.length];
    $('#safety-tip-text').text(tip);
    $('#safety-tip-card').show();
}

// ในไฟล์ app.js
function displayActivitiesUI(activities, listId) {
    const listElement = $(`#${listId}`);
    listElement.empty();
    if (!activities || activities.length === 0) {
        listElement.html(`<div class="empty-state"><i class="fas fa-clipboard-list"></i><h6>ยังไม่มีกิจกรรม</h6><p>ติดตามกิจกรรมความปลอดภัยได้ที่นี่</p></div>`);
        return;
    }
    // Cache full list for filter tabs (only from the full activities page, not filtered subsets)
    if (listId === 'all-activities-list' && !AppState._filterActive) {
        AppState._lastActivities = activities;
        // Reset filter tab to "all" on full reload
        $('.act-filter-btn').removeClass('active');
        $('.act-filter-btn[data-filter="all"]').addClass('active');
    }
    activities.forEach(act => {
        // --- ส่วนที่เพิ่มเข้ามา ---
        let joinButtonHtml = '';
        if (act.userHasSubmitted) {
            // ถ้า User เข้าร่วมแล้ว ให้แสดงปุ่มที่กดไม่ได้
            joinButtonHtml = `
                <button class="btn btn-success" disabled>
                    <i class="fas fa-check-circle me-1"></i> เข้าร่วมแล้ว
                </button>
            `;
        } else {
            // ถ้ายังไม่เคยเข้าร่วม ให้แสดงปุ่มปกติ
            joinButtonHtml = `
                <button class="btn btn-primary btn-join-activity" 
                        data-activity-id="${act.activityId}" 
                        data-activity-title="${sanitizeHTML(act.title)}"
                        data-image-required="${!act.description.includes('[no-image]')}" 
                        data-bs-toggle="tooltip" title="เข้าร่วมกิจกรรม">
                    <i class="fas fa-plus-circle me-1"></i> เข้าร่วม
                </button>
            `;
        }
        // --- จบส่วนที่เพิ่มเข้ามา ---

        const doneBadge = act.userHasSubmitted
            ? `<span class="activity-done-badge"><i class="fas fa-check-circle me-1"></i>ส่งแล้ว</span>`
            : '';
        const countBadge = act.submissionCount > 0
            ? `<span class="activity-count-badge"><i class="fas fa-users me-1"></i>${act.submissionCount} คนร่วม</span>`
            : '';

        const cardHtml = `
            <div class="card activity-card mb-3 ${act.userHasSubmitted ? 'activity-card-done' : ''}">
                <div class="activity-card-img-wrap">
                    <img src="${getFullImageUrl(act.imageUrl, { w: 600 })}"
                         loading="lazy" decoding="async"
                         class="activity-card-img"
                         onerror="this.onerror=null;this.src='https://placehold.co/600x300/e9ecef/6c757d?text=Image';">
                    ${doneBadge}
                    ${countBadge}
                </div>
                <div class="card-body">
                    <h5 class="card-title">${sanitizeHTML(act.title)}</h5>
                    <p class="card-text text-muted small preserve-whitespace">${sanitizeHTML(act.description.replace('[no-image]', ''))}</p>
                    <div class="d-flex justify-content-end align-items-center gap-2 mt-3">
                        <button class="btn btn-sm btn-outline-secondary btn-view-activity-image"
                                data-image-full-url="${getFullImageUrl(act.imageUrl, { w: 1200 })}"
                                ${act.imageUrl ? '' : 'disabled'}
                                data-bs-toggle="tooltip" title="ดูรูปภาพกิจกรรม">
                            <i class="fas fa-image"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-secondary btn-view-report"
                                data-activity-id="${act.activityId}"
                                data-activity-title="${sanitizeHTML(act.title)}"
                                data-bs-toggle="tooltip" title="ดูรายงานทั้งหมด">
                            <i class="fas fa-eye"></i>
                        </button>
                        ${joinButtonHtml}
                    </div>
                </div>
            </div>`;
        listElement.append(cardHtml);
    });
}

function renderSubmissions(submissions) {
    const container = $('#submissions-container');
    container.empty();

    if (!Array.isArray(submissions) || submissions.length === 0) {
        container.html('<p class="text-center text-muted mt-5">ยังไม่มีใครส่งรายงานสำหรับกิจกรรมนี้<br>มาเป็นคนแรกกันเถอะ!</p>');
        return;
    }

    submissions.forEach((sub) => {
        const likedClass = sub.didLike ? 'liked' : '';

        const imageHtml = sub.imageUrl
            ? `
                <img src="${getFullImageUrl(sub.imageUrl, { w: 900 })}"
                     loading="lazy" decoding="async"
                     class="card-img-top submission-image"
                     alt="Submission Image">
              `
            : '';

        let commentsHtml = '';
        if (Array.isArray(sub.comments) && sub.comments.length > 0) {
            commentsHtml = sub.comments.map((c) => `
                <div class="d-flex mb-2">
                    <img src="${c.commenter && c.commenter.pictureUrl ? c.commenter.pictureUrl : 'https://placehold.co/32x32'}"
                         class="rounded-circle me-2 comment-profile-pic"
                         width="32" height="32" alt="Profile">
                    <div>
                        <small class="fw-bold d-block">${sanitizeHTML(c.commenter ? c.commenter.fullName : '')}</small>
                        <small class="text-muted preserve-whitespace">${sanitizeHTML(c.commentText)}</small>
                    </div>
                </div>
            `).join('');
        } else {
            commentsHtml = '<small class="text-muted">ยังไม่มีความคิดเห็น</small>';
        }

        const createdAtText = sub.createdAt
            ? new Date(sub.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
            : '';

        const pointsBadge = sub.points && sub.points > 0
            ? `<span class="badge points-badge"><i class="fas fa-star me-1"></i> ${sub.points} คะแนน</span>`
            : '';

        const deleteButtonHtml = AppState.currentUser && AppState.currentUser.isAdmin
            ? `<button class="btn btn-sm btn-outline-danger btn-delete-submission" data-id="${sub.submissionId}">
                   <i class="fas fa-trash-alt"></i>
               </button>`
            : '';

        // Build reactions HTML
        const EMOJIS = ['👍', '🔥', '💪'];
        const reactHtml = EMOJIS.map(e => {
            const cnt = (sub.reactions && sub.reactions[e]) ? sub.reactions[e] : 0;
            const reacted = sub.myReactions && sub.myReactions.includes(e);
            return `<button class="reaction-btn ${reacted ? 'reacted' : ''}" data-submission-id="${sub.submissionId}" data-emoji="${e}">
                ${e} <span class="reaction-count">${cnt || ''}</span>
            </button>`;
        }).join('');

        const cardHtml = `
            <div class="card shadow-sm mb-3 submission-card">
                ${imageHtml}
                <div class="card-body p-3">
                    <div class="d-flex align-items-center mb-3">
                        <img src="${sub.submitter && sub.submitter.pictureUrl ? sub.submitter.pictureUrl : 'https://placehold.co/45x45'}"
                             class="rounded-circle me-3 profile-pic" alt="Profile Picture">
                        <div>
                            <h6 class="mb-0 submission-submitter">${sanitizeHTML(sub.submitter ? sub.submitter.fullName : '')}</h6>
                            <small class="text-muted">${createdAtText}</small>
                        </div>
                    </div>

                    ${buildCollapsibleDescription(sub.submissionId, sub.description)}

                    <div class="d-flex justify-content-between align-items-center pt-2 border-top">
                        <div class="d-flex align-items-center gap-3">
                            ${pointsBadge}
                            <a href="#" class="text-decoration-none like-btn ${likedClass}"
                               data-submission-id="${sub.submissionId}">
                                <i class="fas fa-heart"></i>
                                <span class="like-count">${sub.likes || 0}</span>
                            </a>
                            ${reactHtml}
                            <a href="#" class="text-decoration-none comment-btn"
                               data-bs-toggle="collapse"
                               data-bs-target="#comments-${sub.submissionId}">
                                <i class="fas fa-comment"></i>
                                ${Array.isArray(sub.comments) ? sub.comments.length : 0}
                            </a>
                            ${sub.imageUrl ? `
                                <a href="#" class="text-decoration-none view-image-btn"
                                   data-image-full-url="${getFullImageUrl(sub.imageUrl, { w: 1200 })}">
                                    <i class="fas fa-search-plus"></i> ดูรูปภาพ
                                </a>
                            ` : ''}
                        </div>
                        ${deleteButtonHtml}
                    </div>

                    <div class="collapse mt-3" id="comments-${sub.submissionId}">
                        <div class="comment-section p-3">
                            <div class="comment-list mb-3">${commentsHtml}</div>
                            <div class="input-group">
                                <input type="text" class="form-control form-control-sm comment-input"
                                       placeholder="แสดงความคิดเห็น...">
                                <button class="btn btn-sm send-comment-button" type="button"
                                        data-submission-id="${sub.submissionId}">ส่ง</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        container.append(cardHtml);
    });
}

function renderAdminChart(chartData) {
    const ctx = document.getElementById('reportsChart').getContext('2d');
    if(AppState.reportsChart) {
        AppState.reportsChart.destroy();
    }
    AppState.reportsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartData.labels,
            datasets: [{
                label: 'จำนวนรายงาน',
                data: chartData.data,
                backgroundColor: 'rgba(6, 199, 85, 0.6)',
                borderColor: 'rgba(6, 199, 85, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'จำนวนรายงาน 7 วันล่าสุด' },
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            }
        }
    });
}

// ===============================================================
//  DATA LOADING FUNCTIONS
// ===============================================================
// app.js

// app.js

async function loadAndShowActivityDetails(activityId, activityTitle, scrollToSubmissionId = null) {
    const modal = $('#activity-detail-modal');
    modal.data('current-activity-id', activityId);
    $('#activity-detail-title').text(activityTitle);
    
    const container = $('#submissions-container');
    $('#submissions-loading').show();
    container.empty();
    
    // ถ้ายังไม่ได้เปิด modal ให้เปิดก่อน
    if (!modal.hasClass('show')) {
        AppState.allModals['activity-detail'].show();
    }

    try {
        const submissions = await callApi('/api/submissions', { activityId, lineUserId: AppState.lineProfile.userId });
        renderSubmissions(submissions);

        // highlight-start
        // --- ส่วนที่เพิ่มเข้ามาเพื่อเลื่อนจอ ---
        if (scrollToSubmissionId) {
            // ใช้ setTimeout เล็กน้อยเพื่อให้แน่ใจว่า DOM ถูก render เสร็จสมบูรณ์แล้ว
            setTimeout(() => {
                const targetCard = $(`.like-btn[data-submission-id="${scrollToSubmissionId}"]`).closest('.submission-card');
                if (targetCard.length) {
                    // สั่งให้เลื่อนจอไปที่ card เป้าหมายอย่างนุ่มนวล
                    targetCard[0].scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            }, 100); // หน่วงเวลา 100 มิลลิวินาที
        }
        // --- จบส่วนเลื่อนจอ ---
        // highlight-end

    } catch (error) { 
        console.error("Error details from loadAndShowActivityDetails:", error); 
        container.html('<p class="text-center text-danger">ไม่สามารถโหลดข้อมูลรายงานได้</p>'); 
    } finally { 
        $('#submissions-loading').hide(); 
    }
}

// ในไฟล์ app.js
async function loadLeaderboard(isLoadMore = false) {
    if (!isLoadMore) {
        // ถ้าเป็นการโหลดครั้งแรก ให้รีเซ็ตค่า
        AppState.leaderboard.currentPage = 1;
        AppState.leaderboard.hasMore = true;
        $('#leaderboard-list').empty();
        $('#leaderboard-load-more-container').hide();
    }

    if (!AppState.leaderboard.hasMore) return; // ถ้าไม่มีข้อมูลแล้วก็ไม่ต้องทำอะไรต่อ

    const list = $('#leaderboard-list');
    const loading = $('#leaderboard-loading');
    const loadMoreBtn = $('#leaderboard-load-more-btn');

    loading.show();
    loadMoreBtn.prop('disabled', true);

    try {
        const users = await callApi('/api/leaderboard', { page: AppState.leaderboard.currentPage });
        loading.hide();

        if (users.length === 0 && !isLoadMore) {
            list.html('<p class="text-center text-muted">ยังไม่มีข้อมูล</p>');
            return;
        }

        users.forEach((user, index) => {
            const rank = ((AppState.leaderboard.currentPage - 1) * 30) + index + 1;
            let rankDisplay = rank;
            if (rank === 1) rankDisplay = '<i class="fas fa-trophy"></i>';
            else if (rank === 2) rankDisplay = '<i class="fas fa-medal text-secondary"></i>';
            else if (rank === 3) rankDisplay = '<i class="fas fa-medal" style="color:#cd7f32;"></i>';

            const isSelf = AppState.lineProfile && user.lineUserId === AppState.lineProfile.userId;
            const selfBadge = isSelf ? `<span class="badge bg-success ms-1 rounded-pill" style="font-size:0.6rem;">คุณ</span>` : '';
            const selfClass = isSelf ? 'leaderboard-item-self' : 'bg-white';
            const itemHtml = `
                <div class="d-flex align-items-center p-2 mb-2 rounded-3 shadow-sm leaderboard-item ${selfClass}">
                    <div class="leaderboard-rank me-3">${rankDisplay}</div>
                    <img src="${user.pictureUrl}" class="rounded-circle me-3" width="45" height="45" onerror="this.onerror=null;this.src='https://placehold.co/45x45';">
                    <div class="flex-grow-1"><div class="fw-bold">${sanitizeHTML(user.fullName)}${selfBadge}</div></div>
                    <div class="fw-bold" style="color: var(--line-green);">${user.totalScore} คะแนน</div>
                </div>`;
            list.append(itemHtml);
        });

        if (users.length < 30) {
            AppState.leaderboard.hasMore = false;
            $('#leaderboard-load-more-container').hide();
        } else {
            AppState.leaderboard.currentPage++;
            $('#leaderboard-load-more-container').show();
        }

        // Show sticky "My Rank" bar
        if (!isLoadMore && AppState.currentUser) {
            const myRankData = users.find(u => u.lineUserId === AppState.lineProfile.userId);
            if (myRankData) {
                const myIdx = users.indexOf(myRankData);
                const myRank = myIdx + 1;
                $('#my-rank-pic').attr('src', AppState.currentUser.pictureUrl || 'https://placehold.co/32x32');
                $('#my-rank-name').text(AppState.currentUser.fullName || '');
                $('#my-rank-text').text(`อันดับ ${myRank} · ${myRankData.totalScore} คะแนน`);
                $('#my-rank-bar').removeClass('d-none');
            } else if (AppState.currentUser.userRank) {
                // User is not in current page — show from profile data
                $('#my-rank-pic').attr('src', AppState.currentUser.pictureUrl || 'https://placehold.co/32x32');
                $('#my-rank-name').text(AppState.currentUser.fullName || '');
                $('#my-rank-text').text(`อันดับ ${AppState.currentUser.userRank} · ${AppState.currentUser.totalScore} คะแนน`);
                $('#my-rank-bar').removeClass('d-none');
            }
        }

    } catch (error) {
        loading.hide();
        list.html('<p class="text-center text-danger">ไม่สามารถโหลดข้อมูลได้</p>');
    } finally {
        loadMoreBtn.prop('disabled', false);
    }
}

async function refreshHomePageData() {
    try {
        // 1. โหลดข้อมูล Profile และ กิจกรรม (ของเดิม)
        const [userDataResponse, activities] = await Promise.all([
            callApi('/api/user/profile', { lineUserId: AppState.lineProfile.userId }),
            callApi('/api/activities', { lineUserId: AppState.lineProfile.userId })
        ]);

        if (userDataResponse.registered) {
            AppState.currentUser = userDataResponse.user;
            updateUserInfoUI(AppState.currentUser);
        }

        displayActivitiesUI(activities, 'all-activities-list');
        loadHomeDashboard(activities);

        // ⭐ 2. เพิ่มบรรทัดนี้: สั่งให้โหลดข้อมูลหน้าเกมใหม่ด้วย
        await loadGameDashboard();
        
        // (แถม) ถ้าอยู่ในหน้า Leaderboard ก็ให้โหลดใหม่ด้วย
        if ($('#leaderboard-page').hasClass('active')) {
            loadLeaderboard(false);
        }

    } catch (error) {
        console.error("Failed to refresh home page data:", error);
        // ไม่ต้อง show error ให้ user เห็นตอน pull refresh มันจะรำคาญ แค่ log ไว้พอ
    }
}

async function loadUserBadges() {
    const container = $('#badges-container');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    container.html('<div class="spinner-border"></div>');
    try {
        const badges = await callApi('/api/user/badges', { lineUserId: AppState.lineProfile.userId });
        container.empty();
        if (badges.length === 0) {
            container.html('<p class="text-muted">ยังไม่มีป้ายรางวัล</p>');
        } else {
            badges.forEach(b => {
                const lockClass = b.isEarned ? '' : 'locked';
                const html = `
                    <div class="badge-item" data-bs-toggle="tooltip" title="${sanitizeHTML(b.name)}: ${sanitizeHTML(b.desc)}">
                         <img src="${getFullImageUrl(b.img, { w: 120 })}"
                              loading="lazy" decoding="async"
                              class="badge-icon ${lockClass}" onerror="this.onerror=null;this.src='https://placehold.co/60x60/e9ecef/6c757d?text=Badge';">
                        <div class="small">${sanitizeHTML(b.name)}</div>
                    </div>`;
                container.append(html);
            });
            const tooltipTriggerList = [].slice.call(container[0].querySelectorAll('[data-bs-toggle="tooltip"]'));
            tooltipTriggerList.map(function (tooltipTriggerEl) {
                return new bootstrap.Tooltip(tooltipTriggerEl);
            });
        }
        
        const earnedBadges = badges.filter(b => b.isEarned).length;
        const totalBadges = badges.length;
        const progress = totalBadges > 0 ? (earnedBadges / totalBadges) * 100 : 0;
        progressBar.css('width', progress + '%').attr('aria-valuenow', progress).text(Math.round(progress) + '%');
        progressText.text(`คุณได้รับ ${earnedBadges} จาก ${totalBadges} ป้ายรางวัลทั้งหมด`);

        // อัปเดต card completion stat — ใช้ cache ถ้ามี ไม่งั้น fetch
        if (AppState._lastCards) {
            const ownedCards = AppState._lastCards.filter(c => c.isOwned).length;
            const totalCards = AppState._lastCards.length;
            const cardPct = totalCards > 0 ? Math.round((ownedCards / totalCards) * 100) : 0;
            $('#profile-page-completion').text(cardPct + '%');
        } else {
            callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId })
                .then(cards => {
                    AppState._lastCards = cards;
                    const ownedCards = cards.filter(c => c.isOwned).length;
                    const cardPct = cards.length > 0 ? Math.round((ownedCards / cards.length) * 100) : 0;
                    $('#profile-page-completion').text(cardPct + '%');
                })
                .catch(() => {});
        }

    } catch (e) {
        container.html('<p class="text-danger">ไม่สามารถโหลดป้ายรางวัลได้</p>');
    }
}


// ===============================================================
//  EVENT LISTENERS
// ===============================================================
// ในไฟล์ app.js ให้นำโค้ดนี้ไปทับฟังก์ชันเดิม
// app.js

function bindStaticEventListeners() {
    $('.nav-link').on('click', function(e) {
        e.preventDefault();
        const pageId = $(this).data('page');
        if (pageId) {
            $('.nav-link').removeClass('active');
            $(this).addClass('active');
            $('.page').removeClass('active');
            $('#' + pageId).addClass('active');

            // Hide rank bar when leaving leaderboard
            if (pageId !== 'leaderboard-page') {
                $('#my-rank-bar').addClass('d-none');
            }
            if (pageId === 'home-page') {
                loadHomeDashboard();
            }
            if (pageId === 'leaderboard-page') {
                loadLeaderboard(false);
            }
            if (pageId === 'profile-page') {
                loadUserBadges();
            }
            if (pageId === 'admin-page') {
                loadAdminDashboard();
            }
            // เพิ่มเงื่อนไขนี้เข้าไป
            if (pageId === 'game-page') {
                // เปลี่ยนมาโหลด Dashboard แทน
                loadGameDashboard(); 
            }
        }
    });

    $('#btn-sync-profile-pic').on('click', async function() {
        const btn = $(this);
        btn.prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-1"></span>กำลังซิงค์...');
        try {
            const freshProfile = await liff.getProfile();
            await callApi('/api/user/refresh-profile', {
                lineUserId: freshProfile.userId,
                displayName: freshProfile.displayName,
                pictureUrl: freshProfile.pictureUrl
            }, 'POST');
            AppState.lineProfile.pictureUrl = freshProfile.pictureUrl;
            AppState.lineProfile.displayName = freshProfile.displayName;
            $('#user-profile-pic, #profile-page-pic, #now-playing-pic').attr('src', freshProfile.pictureUrl);
            await Swal.fire({ icon: 'success', title: 'ซิงค์สำเร็จ!', text: 'อัปเดตรูปโปรไฟล์จาก LINE เรียบร้อยแล้ว', timer: 1800, showConfirmButton: false });
        } catch (e) {
            Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: e.message });
        } finally {
            btn.prop('disabled', false).html('<i class="fas fa-sync-alt me-1"></i>ซิงค์รูปโปรไฟล์');
        }
    });

    $('#registration-form').on('submit', handleRegistration);
    $('#submission-form').on('submit', handleSubmitReport);
    $('#activity-form').on('submit', handleSaveActivity);
    $('#badge-form').on('submit', handleSaveBadge);

    $(document).on('click', '.btn-view-report', handleViewReport);
    $(document).on('click', '.btn-join-activity', handleJoinActivity);
    $(document).on('click', '.like-btn', handleLike);
    $(document).on('click', '.send-comment-button', handleComment);

    // Select all reports checkbox
    $('#select-all-reports').on('change', function() {
        $('.report-select-cb').prop('checked', $(this).is(':checked'));
        updateBulkCount();
    });
    $(document).on('change', '.report-select-cb', updateBulkCount);

    // Bulk approve
    $('#btn-bulk-approve').on('click', async function() {
        const ids = $('.report-select-cb:checked').map((_, el) => $(el).data('id')).get();
        if (ids.length === 0) return Swal.fire('กรุณาเลือกรายการ', '', 'warning');

        // อ่านคะแนนจาก input ของแต่ละ card (ต่างคนต่างคะแนน)
        const scores = {};
        ids.forEach(id => {
            scores[id] = parseInt($(`#score-input-${id}`).val()) || 10;
        });

        // สร้างรายการสรุปเพื่อยืนยัน
        const summaryRows = ids.map(id =>
            `<tr><td class="text-muted small">${id.slice(-6)}</td><td class="fw-bold text-success text-end">${scores[id]} คะแนน</td></tr>`
        ).join('');
        const confirmed = await Swal.fire({
            title: `อนุมัติ ${ids.length} รายการ?`,
            html: `<div style="max-height:200px;overflow-y:auto;">
                     <table class="table table-sm mb-0"><tbody>${summaryRows}</tbody></table>
                   </div>`,
            icon: 'question', showCancelButton: true,
            confirmButtonColor: '#06C755', cancelButtonColor: '#6c757d',
            confirmButtonText: 'อนุมัติเลย', cancelButtonText: 'ยกเลิก'
        });
        if (!confirmed.isConfirmed) return;

        const btn = $(this);
        btn.prop('disabled', true);
        try {
            const res = await callApi('/api/admin/submissions/bulk-approve',
                { submissionIds: ids, scores, requesterId: AppState.lineProfile.userId }, 'POST');
            Swal.fire('สำเร็จ!', `อนุมัติ ${res.approved} รายการ${res.skipped ? `, ข้าม ${res.skipped} รายการ` : ''}`, 'success');
            await loadPendingSubmissions();
        } catch(e) {
            Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
        } finally {
            btn.prop('disabled', false);
        }
    });

    $('#add-badge-btn').on('click', handleAddBadge);

    $('#image-input').on('change', function() { handleImagePreview(this, '#submission-image-preview'); });
    $('#form-activity-image-input').on('change', function() { handleImagePreview(this, '#activity-image-preview'); });
    $('#badge-image-input').on('change', function() { handleImagePreview(this, '#badge-image-preview'); });

    $(document).on('click', '.view-image-btn, .btn-view-activity-image', function(e) {
        e.preventDefault(); 
        const imageUrl = $(this).data('image-full-url');
        if (imageUrl) {
            $('#imageViewerContent').attr('src', imageUrl);
            $('#downloadImageBtn').attr('href', imageUrl);
            const imageViewerModal = new bootstrap.Modal(document.getElementById('imageViewerModal'));
            imageViewerModal.show();
        }
    });
    
    $('#leaderboard-load-more-btn').on('click', () => loadLeaderboard(true));

    // Activity filter tabs
    $(document).on('click', '.act-filter-btn', function() {
        $('.act-filter-btn').removeClass('active');
        $(this).addClass('active');
        const filter = $(this).data('filter');
        const all = AppState._lastActivities || [];
        let filtered;
        if (filter === 'done') filtered = all.filter(a => a.userHasSubmitted);
        else if (filter === 'pending') filtered = all.filter(a => !a.userHasSubmitted);
        else filtered = all;
        AppState._filterActive = (filter !== 'all');
        if (filtered.length === 0) {
            const msg = filter === 'done'
                ? '<div class="empty-state"><i class="fas fa-check-double"></i><h6>ยังไม่ได้ร่วมกิจกรรมไหนเลย</h6><p>ลองเข้าร่วมกิจกรรมดูนะ!</p></div>'
                : filter === 'pending'
                    ? '<div class="empty-state"><i class="fas fa-trophy"></i><h6>ร่วมกิจกรรมครบทุกอย่างแล้ว!</h6><p>เยี่ยมมาก ติดตามกิจกรรมใหม่เร็วๆนี้</p></div>'
                    : '<div class="empty-state"><i class="fas fa-clipboard-list"></i><h6>ยังไม่มีกิจกรรม</h6><p>ติดตามกิจกรรมความปลอดภัยได้ที่นี่</p></div>';
            $('#all-activities-list').html(msg);
        } else {
            displayActivitiesUI(filtered, 'all-activities-list');
        }
        AppState._filterActive = false;
    });

    $(document).on('click', '.sub-expand-btn', function(e) {
        e.preventDefault();
        const id = $(this).data('id');
        $(`#sub-desc-${id} .sub-desc-preview`).addClass('d-none');
        $(`#sub-desc-${id} .sub-desc-full`).removeClass('d-none');
        $(this).remove();
    });

    // highlight-start
    // ---- เพิ่ม Event Listener สำหรับปุ่มแจ้งเตือนไว้ตรงนี้ ----
    $('#notification-bell').on('click', openNotificationCenter);
    // highlight-end
}

function bindAdminEventListeners() {
    $('#view-stats-btn').on('click', handleViewStats);
    $('#manage-reports-btn').on('click', handleManageReports);
    $('#manage-activities-btn').on('click', handleManageActivities);
    $('#manage-badges-btn').on('click', handleManageBadges);
    $('#create-activity-btn').on('click', handleCreateActivity);
    // เพิ่มต่อจากรายการเดิม
    $('#manage-questions-btn').on('click', handleManageQuestions);
    $('#add-question-btn').on('click', handleAddQuestion);
    $('#question-form').on('submit', handleSaveQuestion);
    $('#q-image-input').on('change', function() { handleImagePreview(this, '#q-image-preview'); $('#q-image-preview').show(); });
    // Event Listener สำหรับจัดการการ์ด
    $('#manage-cards-btn').on('click', handleManageCards);
    // ⭐ เพิ่ม 2 บรรทัดนี้
    $('#manage-hunter-btn').on('click', handleManageHunterLevels);
    $('#btn-create-hunter-level').on('click', openHunterEditor); // ใช้ฟังก์ชันเดิมได้เลย    
    $('#add-card-btn').on('click', handleAddCard);
    $('#card-form').on('submit', handleSaveCard);
    $('#card-image-input').on('change', function() { handleImagePreview(this, '#card-image-preview'); $('#card-image-preview').show(); });
    // Event Listener (วางไว้ใน bindAdminEventListeners หรือ document.ready)
    $(document).on('click', '.btn-edit-question', handleEditQuestion);

    // ปุ่ม Edit/Delete ในลิสต์การ์ด
    $(document).on('click', '.btn-edit-card', handleEditCard);
    $(document).on('click', '.btn-delete-card', handleDeleteCard);

    // Event สำหรับปุ่มในรายการคำถาม (Edit/Delete/Toggle)
    $(document).on('click', '.btn-edit-question', handleEditQuestion);
    $(document).on('click', '.btn-delete-q', handleDeleteQuestion);
    $(document).on('click', '.btn-toggle-q', handleToggleQuestion);
    $(document).on('click', '.btn-approve, .btn-reject', handleApprovalAction);
    $(document).on('click', '.btn-edit-activity', handleEditActivity);
    $(document).on('click', '.btn-toggle-activity', handleToggleActivity);
    $(document).on('click', '.delete-badge-btn', handleDeleteBadge);
    $(document).on('click', '.btn-edit-badge', handleEditBadge);
    $(document).on('click', '.btn-delete-activity', handleDeleteActivity);
    $(document).on('click', '.btn-delete-submission', handleDeleteSubmission);
    // ===== START: Event Listeners for Idea 3 =====
    $(document).on('click', '.user-card', function() { handleViewUserDetails($(this).data('userid')); });
    $(document).on('click', '.badge-toggle-btn', handleToggleBadge);
    // ===== END: Event Listeners for Idea 3 =====

    // --- HUNTER ADMIN: สลับโหมด Upload / URL ---
    $(document).on('change', 'input[name="hunter-img-source"]', function() {
        const mode = $(this).val();
        if(mode === 'upload') {
            $('#hunter-input-group-upload').show();
            $('#hunter-input-group-url').hide();
        } else {
            $('#hunter-input-group-upload').hide();
            $('#hunter-input-group-url').show();
        }
    });

    // --- HUNTER ADMIN: พิมพ์ URL แล้วโชว์รูป Preview ทันที ---
    $(document).on('input', '#editor-url-text', function() {
        const url = $(this).val().trim();
        if(url) {
            $('#editor-preview-img').attr('src', url).parent().show();
            $('#editor-placeholder').hide();
        }
    });

    // --- GAME MONITOR LOGIC (Complete Fixed Version) ---

    $('#btn-admin-analytics').on('click', async function(e) {
        e.preventDefault();
        AppState.allModals['admin-analytics'].show();
        await loadAdminAnalytics();
    });
    $('#btn-department-scores').on('click', async function(e) {
        e.preventDefault();
        AppState.allModals['admin-dept'].show();
        await loadDepartmentScores();
    });
    $('#btn-export-reports').on('click', function(e) {
        e.preventDefault();
        AppState.allModals['admin-export'].show();
    });
    $('#btn-export-csv').on('click', handleExportCSV);
    $('#btn-export-pdf').on('click', handleExportPDF);
    $('#btn-audit-log').on('click', function(e) {
        e.preventDefault();
        AppState.allModals['admin-audit'].show();
        loadAdminAuditLogs(1);
    });
    $('#btn-audit-search').on('click', function() { loadAdminAuditLogs(1); });
    $('#btn-audit-prev').on('click', function() {
        const cur = Number($('#btn-audit-prev').data('page') || 1);
        if (cur > 1) loadAdminAuditLogs(cur - 1);
    });
    $('#btn-audit-next').on('click', function() {
        const cur = Number($('#btn-audit-prev').data('page') || 1);
        const total = Number($('#btn-audit-prev').data('total') || 0);
        const limit = 50;
        if (cur * limit < total) loadAdminAuditLogs(cur + 1);
    });

    // ผูกปุ่มและแท็บ
    $(document).on('click', '#btn-game-monitor', function() {
        const modal = new bootstrap.Modal(document.getElementById('admin-monitor-modal'));
        modal.show();
        loadKytMonitor();
    });

    $('button[data-bs-target="#tab-kyt"]').on('shown.bs.tab', loadKytMonitor);
    $('button[data-bs-target="#tab-hunter"]').on('shown.bs.tab', loadHunterMonitor);
    $('button[data-bs-target="#tab-streak"]').on('shown.bs.tab', loadStreakMonitor);
    $('button[data-bs-target="#tab-coins"]').on('shown.bs.tab', loadCoinMonitor); // ⭐ เพิ่มแท็บเหรียญ

    // Function 1: KYT
    async function loadKytMonitor() {
        const list = $('#monitor-kyt-list');
        list.html('<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>');
        try {
            const data = await callApi('/api/admin/monitor/kyt');
            list.empty();
            if (data.length === 0) { list.html('<div class="text-center text-muted mt-4">วันนี้ยังไม่มีใครเล่น KYT</div>'); return; }

            list.append(`<div class="list-group-item bg-success text-white fw-bold"><i class="fas fa-users me-2"></i> เล่นแล้ววันนี้: ${data.length} คน</div>`);

            data.forEach(u => {
                const statusBadge = u.isCorrect
                    ? '<span class="badge bg-success">ถูกต้อง ✅</span>'
                    : '<span class="badge bg-danger">ผิด ❌</span>';
                const answerText = u.selectedOption
                    ? `ตอบ: <strong>${u.selectedOption}</strong>${u.isCorrect ? '' : ` (ถูก: ${u.correctOption})`}`
                    : '';

                const kytData = encodeURIComponent(JSON.stringify({
                    id: u.id,
                    userId: u.lineUserId,
                    name: u.fullName,
                    isCorrect: u.isCorrect,
                    score: u.earnedPoints,
                    question: u.questionText
                }));

                list.append(`
                    <div class="list-group-item d-flex align-items-center justify-content-between">
                        <div class="d-flex align-items-center">
                            <img src="${u.pictureUrl || ''}" onerror="this.src='https://placehold.co/40?text=User'" class="rounded-circle me-3" width="40" height="40">
                            <div>
                                <div class="fw-bold">${u.fullName}</div>
                                <small class="text-muted">รหัส: ${u.employeeId}</small>
                                ${answerText ? `<br><small class="text-muted">${answerText}</small>` : ''}
                            </div>
                        </div>
                        <div class="text-end">
                            ${statusBadge}<br>
                            <small class="text-muted">+${u.earnedPoints} คะแนน</small>
                            <button class="btn btn-sm btn-outline-warning ms-2 btn-edit-kyt" data-kyt="${kytData}">
                                <i class="fas fa-edit"></i>
                            </button>
                        </div>
                    </div>
                `);
            });
        } catch (e) { list.html(`<div class="text-danger p-3">${e.message}</div>`); }
    }

    // Function 2: Hunter
    async function loadHunterMonitor() {
        const list = $('#monitor-hunter-list');
        list.html('<div class="text-center py-4"><div class="spinner-border text-danger"></div></div>');
        try {
            const data = await callApi('/api/admin/monitor/hunter');
            list.empty();
            if (data.length === 0) { list.html('<div class="text-center text-muted mt-4">ยังไม่มีข้อมูล</div>'); return; }

            data.forEach(h => {
                const time = new Date(h.clearedAt).toLocaleString('th-TH', { hour:'2-digit', minute:'2-digit', day:'numeric', month:'short' });
                let stars = ''; for(let i=1; i<=3; i++) stars += i <= h.stars ? '⭐' : '⚫';
                list.append(`
                    <div class="list-group-item d-flex align-items-center">
                        <img src="${h.pictureUrl || ''}" onerror="this.src='https://placehold.co/40?text=User'" class="rounded-circle me-3" width="40" height="40">
                        <div class="flex-grow-1"><div class="fw-bold">${h.fullName}</div><small class="text-primary"><i class="fas fa-map-marker-alt me-1"></i>${h.title}</small></div>
                        <div class="text-end"><div class="text-warning small" style="letter-spacing: -2px;">${stars}</div><small class="text-muted" style="font-size:0.75rem;">${time}</small></div>
                    </div>
                `);
            });
        } catch (e) { list.html(`<div class="text-danger p-3">${e.message}</div>`); }
    }

    // Function 3: Streak
    async function loadStreakMonitor() {
        const list = $('#monitor-streak-list');
        list.html('<div class="text-center py-4"><div class="spinner-border text-warning"></div></div>');
        try {
            const data = await callApi('/api/admin/monitor/streaks');
            list.empty();
            if (data.length === 0) { list.html('<div class="text-center text-muted mt-4">ยังไม่มีข้อมูล</div>'); return; }

            data.forEach((u, index) => {
                const rank = index + 1;
                let rankBadge = `<span class="badge bg-secondary rounded-pill me-2">${rank}</span>`;
                if (rank === 1) rankBadge = `<span class="badge bg-warning text-dark rounded-pill me-2">🥇 1</span>`;
                
                // เช็คว่าเล่นวันนี้หรือยัง (เทียบกับเวลาไทย)
                const lastPlayed = new Date(u.lastPlayedDate).setHours(0,0,0,0);
                const now = new Date();
                const thaiNow = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Bangkok"})); // แปลงเป็นเวลาไทย
                const today = thaiNow.setHours(0,0,0,0);
                
                const isPlayedToday = lastPlayed === today;
                const statusDot = isPlayedToday ? '<i class="fas fa-circle text-success small"></i>' : '<i class="fas fa-circle text-danger small"></i>';

                list.append(`
                    <div class="list-group-item d-flex align-items-center">
                        <div style="width: 40px; text-align: center;">${rankBadge}</div>
                        <img src="${u.pictureUrl || ''}" onerror="this.src='https://placehold.co/40?text=User'" class="rounded-circle me-3" width="40" height="40">
                        <div class="flex-grow-1"><div class="fw-bold">${u.fullName}</div><small class="text-muted">Streak: <b class="text-danger">${u.currentStreak} วัน</b></small></div>
                        <div>${statusDot}</div>
                    </div>
                `);
            });
        } catch (e) { list.html(`<div class="text-danger p-3">${e.message}</div>`); }
    }

    // ⭐ Function 4: Coins (ใหม่)
    async function loadCoinMonitor() {
        const list = $('#monitor-coin-list');
        list.html('<div class="text-center py-4"><div class="spinner-border text-warning"></div></div>');
        try {
            const data = await callApi('/api/admin/monitor/coins');
            list.empty();
            if (data.length === 0) { list.html('<div class="text-center text-muted mt-4">ไม่มีข้อมูล</div>'); return; }

            data.forEach((u, index) => {
                const rank = index + 1;
                let rankBadge = `<span class="badge bg-light text-dark border me-2">#${rank}</span>`;
                if (rank === 1) rankBadge = `<span class="badge bg-warning text-dark me-2">👑 1</span>`;
                
                const coins = u.coinBalance ? u.coinBalance.toLocaleString() : "0";

                list.append(`
                    <div class="list-group-item d-flex align-items-center">
                        <div style="width: 40px; text-align: center;">${rankBadge}</div>
                        <img src="${u.pictureUrl || ''}" onerror="this.src='https://placehold.co/40?text=User'" class="rounded-circle me-3" width="40" height="40">
                        <div class="flex-grow-1"><div class="fw-bold">${u.fullName}</div><small class="text-muted">รหัส: ${u.employeeId}</small></div>
                        <div class="text-end"><span class="badge bg-warning text-dark fs-6"><i class="fas fa-coins me-1"></i> ${coins}</span></div>
                    </div>
                `);
            });
        } catch (e) { list.html(`<div class="text-danger p-3">${e.message}</div>`); }
    }
}


function bindAdminTabEventListeners() {
    $('.admin-tab-btn').on('click', function(e) {
        e.preventDefault();
        $('.admin-tab-btn').removeClass('active');
        $(this).addClass('active');
        $('.admin-tab-content').hide();
        const tab = $(this).data('tab');
        $('#' + tab + 'Tab').show();

        if (tab === 'manageBadges') {
            loadBadgesForAdmin();
        } else if (tab === 'manageUsers') {
            const searchQuery = $('#user-search-input').val();
            if (searchQuery.length > 0) {
                searchUsersForAdmin(searchQuery);
            } else {
                loadUsersForAdmin();
            }
        }
    });
    
    $('#user-search-input').on('input', function() {
        const query = $(this).val();
        if (query.length > 2) {
            searchUsersForAdmin(query);
        } else if (query.length === 0) {
            loadUsersForAdmin();
        }
    });

    $('#users-load-more-btn').on('click', () => {
        fetchAdminUsers(AppState.adminUsers.currentPage, AppState.adminUsers.currentSearch, true);
    });

    $('#export-users-csv-btn').on('click', function() {
        const users = AppState._cachedAdminUsers;
        if (!users || users.length === 0) {
            return Swal.fire('ไม่มีข้อมูล', 'กรุณาโหลดรายชื่อผู้ใช้ก่อน', 'warning');
        }
        const headers = ['ชื่อ-นามสกุล', 'รหัสพนักงาน', 'คะแนนรวม', 'เหรียญ', 'จำนวนป้าย'];
        const rows = users.map(u => [
            `"${(u.fullName || '').replace(/"/g, '""')}"`,
            `"${(u.employeeId || '').replace(/"/g, '""')}"`,
            u.totalScore || 0,
            u.coinBalance || 0,
            u.badgeCount || 0
        ].join(','));
        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `users_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // ---- เพิ่ม Event Listener สำหรับปุ่ม Sort ----
    $('#user-sort-options').on('click', '.btn-sort', function() {
        const btn = $(this);
        const sortBy = btn.data('sort');

        // ถ้ากดปุ่มที่ Active อยู่แล้ว ไม่ต้องทำอะไร
        if (btn.hasClass('active')) {
            return;
        }

        // อัปเดต UI ของปุ่ม — สลับ active style ให้ชัดเจน
        $('#user-sort-options .btn-sort')
            .removeClass('active btn-secondary')
            .addClass('btn-outline-secondary');
        btn.removeClass('btn-outline-secondary').addClass('active btn-secondary');

        // อัปเดต state
        AppState.adminUsers.currentSort = sortBy;

        // เรียกข้อมูลใหม่ โดยเริ่มจากหน้า 1 เสมอเมื่อมีการเปลี่ยนการเรียงลำดับ
        const currentQuery = $('#user-search-input').val();
        fetchAdminUsers(1, currentQuery, false);
    });
}

// --- ADMIN: โหลดหน้ารายการด่าน ---
async function handleManageHunterLevels() {
    const list = $('#admin-hunter-list');
    list.html('<div class="col-12 text-center my-5"><div class="spinner-border text-success"></div></div>');
    
    // เปิด Modal ใหม่
    const modal = new bootstrap.Modal(document.getElementById('admin-hunter-manage-modal'));
    AppState.allModals['admin-hunter-manage'] = modal;
    modal.show();

    try {
        // ดึงข้อมูลด่าน (ใช้ API ตัวเดิมได้เลย)
        const levels = await callApi('/api/game/hunter/levels', { lineUserId: AppState.lineProfile.userId });
        list.empty();

        if (levels.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีด่านในระบบ</div>');
            return;
        }

        levels.forEach(l => {
            const safeTitle = sanitizeHTML(l.title);
            
            // สร้าง Card สำหรับ Admin (เน้นปุ่มจัดการ)
            list.append(`
                <div class="col-12 col-md-6 col-lg-4">
                    <div class="card shadow-sm h-100">
                        <div class="d-flex">
                            <img src="${getFullImageUrl(l.imageUrl)}" class="rounded-start" style="width: 120px; height: 120px; object-fit: cover;">
                            <div class="card-body p-2 d-flex flex-column justify-content-center">
                                <h6 class="fw-bold mb-1 text-truncate">${safeTitle}</h6>
                                <small class="text-muted mb-2"><i class="fas fa-bomb text-danger"></i> ${l.totalHazards} จุดเสี่ยง</small>
                                
                                <div class="d-flex gap-2 mt-auto">
                                    <button class="btn btn-sm btn-outline-primary flex-grow-1" onclick="editHunterLevel('${l.levelId}')">
                                        <i class="fas fa-edit"></i> แก้ไข
                                    </button>
                                    <button class="btn btn-sm btn-outline-danger flex-grow-1" onclick="deleteHunterLevel('${l.levelId}')">
                                        <i class="fas fa-trash"></i> ลบ
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `);
        });

    } catch (e) {
        list.html(`<div class="text-center text-danger">Error: ${e.message}</div>`);
    }
}

// แสดงรายชื่อผู้ใช้สำหรับมอบป้ายรางวัล
function renderUserListForBadge(users) {
    const listEl = $("#badge-user-list");
    listEl.empty();

    if (!users || users.length === 0) {
        listEl.append(`<p class="text-center text-red-500">ไม่พบผู้ใช้</p>`);
        return;
    }

    users.forEach(u => {
        const score = (typeof u.totalScore === 'number' && !isNaN(u.totalScore))
            ? u.totalScore
            : 0;

        listEl.append(`
            <div class="user-item flex justify-between items-center py-3 border-b cursor-pointer"
                 onclick="viewUserBadgeDetail('${u.lineUserId}')">
                <div>
                    <div class="font-bold">${u.fullName || '-'}</div>
                    <div class="text-sm text-gray-600">รหัส: ${u.employeeId || '-'}</div>
                    <div class="text-sm text-yellow-600">คะแนน: ${score}</div>
                </div>
                <div>
                    <i class="fa-solid fa-chevron-right"></i>
                </div>
            </div>
        `);
    });
}

// ===============================================================
//  EVENT HANDLER FUNCTIONS
// ===============================================================
async function handleRegistration(e) {
    e.preventDefault();
    const fullName = $('#fullName').val().trim();
    const employeeId = $('#employeeId').val().trim();
    const department = $('#reg-department').val();
    if (!department) {
        Swal.fire({ icon: 'warning', title: 'กรุณาเลือกแผนก', text: 'จำเป็นต้องระบุแผนก / หน่วยงานเพื่อลงทะเบียน' });
        return;
    }
    showLoading('กำลังบันทึก...');
    try {
        const newUser = await callApi("/api/user/register", { lineUserId: AppState.lineProfile.userId, displayName: AppState.lineProfile.displayName, pictureUrl: AppState.lineProfile.pictureUrl, fullName: fullName, employeeId: employeeId, department: department }, 'POST');
        $('#registration-page').hide();
        await showMainApp(newUser);
        showSuccess('ลงทะเบียนเรียบร้อย!');
    } catch (error) { showError(error.message); }
}

function setUploadProgress(label, pct) {
    $('#upload-progress-area').show();
    $('#upload-progress-label').text(label);
    $('#upload-progress-pct').text(pct + '%');
    $('#upload-progress-bar').css('width', pct + '%');
}

async function handleSubmitReport(e) {
    e.preventDefault();
    const imageFile = $('#image-input')[0].files[0];
    const description = $('#description-input').val().trim();
    if (!description) { return showWarning('กรุณากรอกรายละเอียดจุดเสี่ยง'); }
    const submitBtn = $('#submission-form button[type="submit"]');
    submitBtn.prop('disabled', true);
    try {
        let imageUrl = null;
        if (imageFile) {
            setUploadProgress('กำลังบีบอัดและอัปโหลดรูปภาพ...', 20);
            imageUrl = await uploadImage(imageFile);
            setUploadProgress('อัปโหลดรูปภาพสำเร็จ ✓', 70);
        } else {
            setUploadProgress('กำลังส่งรายงาน...', 40);
        }
        setUploadProgress('กำลังบันทึกรายงาน...', 85);
        const payload = { lineUserId: AppState.lineProfile.userId, activityId: $('#activityId-input').val(), description: description, imageUrl: imageUrl };
        await callApi('/api/submissions', payload, 'POST');
        setUploadProgress('ส่งรายงานสำเร็จ! ✓', 100);
        await new Promise(r => setTimeout(r, 400));
        AppState.allModals.submission.hide();
        $('#submission-form')[0].reset();
        $('#submission-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
        fireConfetti('default');
        showSuccess('รายงานของคุณถูกส่งเพื่อรอการตรวจสอบแล้ว 🎉');
        const activityId = $('#activityId-input').val();
        const activityButton = $(`.btn-join-activity[data-activity-id="${activityId}"]`);
        if (activityButton.length > 0) {
            activityButton
                .prop('disabled', true)
                .removeClass('btn-primary')
                .addClass('btn-success')
                .html('<i class="fas fa-check-circle me-1"></i> เข้าร่วมแล้ว');
        }
    } catch (error) {
        showError(error.message);
    } finally {
        submitBtn.prop('disabled', false);
        $('#upload-progress-area').hide();
        $('#upload-progress-bar').css('width', '0%');
    }
}

function handleViewReport() {
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');
    loadAndShowActivityDetails(activityId, activityTitle);
}

function openActivitySubmission(activityId, activityTitle, isImageRequired) {
    const imageUploadSection = $('#image-upload-section');
    const imageInput = $('#image-input');
    if (isImageRequired) {
        imageUploadSection.show();
        imageInput.prop('required', true);
    } else {
        imageUploadSection.hide();
        imageInput.prop('required', false);
    }
    $('#activityId-input').val(activityId);
    $('#activity-title-modal').text(activityTitle);
    AppState.allModals['submission'].show();
}

function handleJoinActivity() {
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');
    const isImageRequired = $(this).data('image-required');
    openActivitySubmission(activityId, activityTitle, isImageRequired);
}

async function handleLike(e) {
    e.preventDefault();
    const btn = $(this);
    const submissionId = btn.data('submission-id');
    btn.css('pointer-events', 'none'); 
    try {
        const result = await callApi('/api/submissions/like', { submissionId, lineUserId: AppState.lineProfile.userId }, 'POST');
        const countSpan = btn.find('.like-count');
        countSpan.text(result.newLikeCount);
        btn.toggleClass('liked', result.status === 'liked');
    } catch (error) {
        console.error("Like failed:", error);
    } finally {
        btn.css('pointer-events', 'auto'); 
    }
}

$(document).on('click', '.reaction-btn', async function() {
    const btn = $(this);
    const submissionId = btn.data('submission-id');
    const emoji = btn.data('emoji');
    btn.prop('disabled', true);
    try {
        const res = await callApi('/api/submissions/react', { submissionId, lineUserId: AppState.lineProfile.userId, emoji }, 'POST');
        const countSpan = btn.find('.reaction-count');
        countSpan.text(res.newCount);
        btn.toggleClass('reacted', res.reacted);
    } catch(e) {
        console.error('React failed:', e);
    } finally {
        btn.prop('disabled', false);
    }
});

// app.js (แก้ไขในฟังก์ชัน handleComment)

async function handleComment(e) {
    e.preventDefault();
    const btn = $(this);
    const submissionId = btn.data('submission-id');
    const input = btn.siblings('.comment-input');
    const commentText = input.val().trim();
    if(!commentText) return;
    
    btn.prop('disabled', true);
    
    try {
        await callApi('/api/submissions/comment', { submissionId, lineUserId: AppState.lineProfile.userId, commentText }, 'POST');
        
        const modal = $('#activity-detail-modal');
        const currentActivityId = modal.data('current-activity-id');
        const activityTitle = $('#activity-detail-title').text();
        if (currentActivityId) {
           // highlight-start
           // ส่ง submissionId เพิ่มเข้าไปเป็น parameter ที่ 3
           loadAndShowActivityDetails(currentActivityId, activityTitle, submissionId); 
           // highlight-end
        }
    } catch (e) { 
        showError('ไม่สามารถเพิ่มความคิดเห็นได้'); 
        // highlight-start
        // เพิ่มบรรทัดนี้เพื่อให้ปุ่มกลับมาใช้งานได้แม้จะเกิด Error
        btn.prop('disabled', false); 
        // highlight-end
    } 
    // ไม่ต้องมี finally แล้ว เพราะเราจัดการ btn.prop('disabled', false) ใน catch แล้ว
}

function handleImagePreview(input, previewSelector) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) { $(previewSelector).attr('src', e.target.result); }
        reader.readAsDataURL(input.files[0]);
    }
}

function updateBulkCount() {
    $('#bulk-selected-count').text($('.report-select-cb:checked').length);
}

// --- Admin Handlers ---
async function handleViewStats() { await loadAdminStats(); AppState.allModals['admin-stats'].show(); }
async function handleManageReports() { await loadPendingSubmissions(); AppState.allModals['admin-reports'].show(); }
async function handleManageActivities() { await loadAllActivitiesForAdmin(); AppState.allModals['admin-activities'].show(); }
function handleCreateActivity() {
    $('#activity-form-title').text('สร้างกิจกรรมใหม่');
    $('#activity-form')[0].reset();
    $('#form-activity-id').val('');
    $('#form-activity-image-url-input').val('');
    $('#activity-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
    AppState.allModals['activity-form'].show();
}

// This function creates a new UI function to be reusable
function displayActivitiesUIForAdmin(activities) {
    const list = $('#activities-list-admin');
    list.empty();
    activities.forEach(a => {
        const statusBadge = a.status === 'active' ? 'bg-success' : 'bg-secondary';
        const btnText = a.status === 'active' ? 'ปิดใช้งาน' : 'เปิดใช้งาน';
        const btnClass = a.status === 'active' ? 'btn-outline-secondary' : 'btn-outline-success';
        const activityData = encodeURIComponent(JSON.stringify(a));
        const html = `
            <div class="card mb-2"><div class="card-body d-flex align-items-center">
                <div><span class="badge ${statusBadge} me-2">${a.status}</span><strong>${sanitizeHTML(a.title)}</strong></div>
                <div class="ms-auto">
                    <button class="btn btn-sm btn-primary btn-edit-activity me-1" data-activity-data='${activityData}'><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm ${btnClass} btn-toggle-activity me-1" data-id="${a.activityId}">${btnText}</button>
                    <button class="btn btn-sm btn-danger btn-delete-activity" data-id="${a.activityId}"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div></div>`;
        list.append(html);
    });
}

// ในไฟล์ app.js
async function handleSaveActivity(e) {
    e.preventDefault();
    showLoading('กำลังบันทึก...');
    const imageFile = $('#form-activity-image-input')[0].files[0];
    const imageUrlInput = $('#form-activity-image-url-input').val().trim();
    const existingImageUrl = $('#form-activity-image-url').val();

    try {
        let finalImageUrl = existingImageUrl;
        if (imageFile) {
            finalImageUrl = await uploadImage(imageFile);
        } else if (imageUrlInput) {
            finalImageUrl = imageUrlInput;
        }

        // ===== ส่วนที่แก้ไข =====
        let description = $('#form-activity-desc').val();
        const noImageTag = '[no-image]';
        const isImageRequired = $('#image-required-toggle').is(':checked');

        // 1. ลบแท็กเก่าทิ้งก่อนเสมอ เพื่อป้องกันการซ้ำซ้อน
        description = description.replace(noImageTag, '').trim();

        if (!isImageRequired) {
          // 2. ถ้า "ไม่บังคับ" (สวิตช์ถูกปิด) ค่อยเติมแท็กเข้าไปใหม่
          description += noImageTag;
        }
        // =======================

        const payload = {
            activityId: $('#form-activity-id').val(),
            title: $('#form-activity-title').val(),
            description: description, // <--- 3. ใช้ตัวแปร description ที่เราจัดการแท็กแล้ว
            imageUrl: finalImageUrl
        };

        const isUpdate = !!payload.activityId;
        const method = isUpdate ? 'PUT' : 'POST';
        await callApi('/api/admin/activities', payload, method);
        
        AppState.allModals['activity-form'].hide();
        showSuccess('บันทึกกิจกรรมเรียบร้อย');

        const allActivities = await callApi('/api/admin/activities');
        
        displayActivitiesUIForAdmin(allActivities); 

        const activeActivities = allActivities.filter(act => act.status === 'active');
        displayActivitiesUI(activeActivities, 'latest-activities-list');
        displayActivitiesUI(activeActivities, 'all-activities-list');

    } catch (e) {
        showError(e.message);
    }
}
// ===== START: Idea 4 - Safer Delete Confirmation =====
// ในไฟล์ app.js ฟังก์ชัน handleDeleteActivity
// ในไฟล์ app.js ให้นำฟังก์ชันนี้ไปทับของเดิมทั้งหมด
async function handleDeleteActivity() {
    const activityId = $(this).data('id');
    const activityTitle = $(this).closest('.card-body').find('strong').text();

    // ===== แก้ไข Swal.fire ทั้งหมดเป็นแบบนี้ =====
    const result = await Swal.fire({
        title: 'ยืนยันการลบ',
        html: `คุณต้องการลบกิจกรรม "<b>${sanitizeHTML(activityTitle)}</b>" ใช่ไหม?`,
        text: "การกระทำนี้ไม่สามารถย้อนกลับได้!",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#6e7881',
        confirmButtonText: 'ใช่, ลบเลย!',
        cancelButtonText: 'ยกเลิก'
    });
    // ===========================================

    if (result.isConfirmed) {
        try {
            await callApi(`/api/admin/activities/${activityId}`, {}, 'DELETE');
            Swal.fire('ลบสำเร็จ!', 'กิจกรรมและรายงานที่เกี่ยวข้องถูกลบแล้ว', 'success');
            loadAllActivitiesForAdmin(); // Reload admin list
            const activities = await callApi('/api/activities', { lineUserId: AppState.lineProfile.userId });
            displayActivitiesUI(activities, 'latest-activities-list');
            displayActivitiesUI(activities, 'all-activities-list');
        } catch (e) {
            showError(e.message);
        }
    }
}
// ===== END: Idea 4 - Safer Delete Confirmation =====

async function handleApprovalAction() {
    const btn = $(this);
    const action = btn.hasClass('btn-approve') ? 'approve' : 'reject';
    const id = btn.data('id');
    const score = $(`#score-input-${id}`).val();

    // ถามยืนยันก่อนทำการ Approve/Reject
    const actionLabel = action === 'approve' ? 'อนุมัติ' : 'ปฏิเสธ';
    const actionColor = action === 'approve' ? '#06C755' : '#dc3545';
    const confirm = await Swal.fire({
        title: `ยืนยันการ${actionLabel}?`,
        text: action === 'approve' ? `จะให้คะแนน ${score} คะแนนแก่ผู้ส่ง` : 'รายงานนี้จะถูกปฏิเสธ',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: actionColor,
        cancelButtonColor: '#6c757d',
        confirmButtonText: `ใช่, ${actionLabel}`,
        cancelButtonText: 'ยกเลิก'
    });
    if (!confirm.isConfirmed) return;

    const card = $(`#report-card-${id}`);
    card.css('opacity', '0.5');
    btn.prop('disabled', true).closest('.d-flex').find('button, input').prop('disabled', true);
    try {
        if (action === 'approve') {
            await callApi('/api/admin/submissions/approve', {
                submissionId: id,
                score: score,
                requesterId: AppState.lineProfile.userId
            }, 'POST');
        } else {
            await callApi('/api/admin/submissions/reject', {
                submissionId: id,
                requesterId: AppState.lineProfile.userId
            }, 'POST');
        }
        if (action === 'approve') fireConfetti('default');
        card.slideUp(500, function() {
            $(this).remove();
            const newCount = $('.report-card').length;
            $('#pending-count-modal').text(newCount);
            if(newCount === 0) $('#no-reports-message').show();
        });
    } catch (e) {
        showError('เกิดข้อผิดพลาด');
        card.css('opacity', '1');
        btn.prop('disabled', false).closest('.d-flex').find('button, input').prop('disabled', false);
    }
}
async function handleEditActivity() {
    const data = JSON.parse(decodeURIComponent($(this).data('activity-data')));
    $('#activity-form-title').text('แก้ไขกิจกรรม');
    $('#activity-form')[0].reset();
    $('#form-activity-id').val(data.activityId);
    $('#form-activity-title').val(data.title);
    const description = data.description || '';
    const noImageTag = '[no-image]';
    const isImageRequired = !description.includes(noImageTag);
    $('#image-required-toggle').prop('checked', isImageRequired);
    $('#form-activity-desc').val(description.replace(noImageTag, ''));
    $('#form-activity-image-url').val(data.imageUrl);
    $('#form-activity-image-url-input').val('');
    $('#activity-image-preview').attr('src', getFullImageUrl(data.imageUrl));
    AppState.allModals['activity-form'].show();
}
async function handleToggleActivity() {
    const btn = $(this);
    const id = btn.data('id');
    const currentLabel = btn.text().trim();
    const isActivating = currentLabel === 'เปิดใช้งาน';
    const actionLabel = isActivating ? 'เปิดใช้งาน' : 'ปิดใช้งาน';

    const confirmResult = await Swal.fire({
        title: `ยืนยันการ${actionLabel}?`,
        text: isActivating ? 'ผู้ใช้จะมองเห็นกิจกรรมนี้ทันที' : 'ผู้ใช้จะไม่สามารถส่งงานกิจกรรมนี้ได้',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: isActivating ? '#06C755' : '#dc3545',
        cancelButtonColor: '#6c757d',
        confirmButtonText: `ใช่, ${actionLabel}`,
        cancelButtonText: 'ยกเลิก'
    });
    if (!confirmResult.isConfirmed) return;

    btn.prop('disabled', true);
    try {
        await callApi('/api/admin/activities/toggle', { activityId: id }, 'POST');
        loadAllActivitiesForAdmin();
    } catch (e) {
        console.error("Toggle failed:", e);
        btn.prop('disabled', false);
    }
}
async function handleDeleteSubmission() {
    const submissionId = $(this).data('id');
    const result = await Swal.fire({
        title: 'แน่ใจหรือไม่?',
        text: "คุณต้องการลบรายงานนี้ใช่ไหม?",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'ใช่, ลบเลย!',
        cancelButtonText: 'ยกเลิก'
    });
    if (result.isConfirmed) {
        showLoading('กำลังลบรายงาน...');
        try {
            await callApi(`/api/admin/submissions/${submissionId}`, {}, 'DELETE');
            showSuccess('ลบรายงานเรียบร้อย');
            const modal = $('#activity-detail-modal');
            const currentActivityId = modal.data('current-activity-id');
            const activityTitle = $('#activity-detail-title').text();
            if(currentActivityId) loadAndShowActivityDetails(currentActivityId, activityTitle);
        } catch (e) {
            showError(e.message);
        }
    }
}
function handleManageBadges() {
    AppState.allModals['admin-manage-badges'].show();
    $('.admin-tab-btn[data-tab="manageBadges"]').addClass('active').siblings().removeClass('active');
    $('#manageBadgesTab').show().siblings('.admin-tab-content').hide();
    loadBadgesForAdmin();
}
function handleAddBadge() {
    $('#badge-form-title').text('เพิ่มป้ายรางวัลใหม่');
    $('#badge-form')[0].reset();
    $('#badge-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
    AppState.allModals['badge-form'].show();
}
async function handleSaveBadge(e) {
    e.preventDefault();
    showLoading('กำลังบันทึก...');
    const imageFile = $('#badge-image-input')[0].files[0];
    const existingImageUrl = $('#badge-image-url-input').val();
    
    try {
        let finalImageUrl = existingImageUrl;
        if (imageFile) {
            finalImageUrl = await uploadImage(imageFile);
        }
        const payload = {
            badgeName: $('#badge-name-input').val(),
            description: $('#badge-desc-input').val(),
            badgeId: $('#badge-id-input').val()
        };
        payload.imageUrl = finalImageUrl;

        const method = payload.badgeId ? 'PUT' : 'POST';
        const url = payload.badgeId ? `/api/admin/badges/${payload.badgeId}` : '/api/admin/badges';
        await callApi(url, payload, method);
        
        AppState.allModals['badge-form'].hide();
        showSuccess('บันทึกป้ายรางวัลเรียบร้อย');
        loadBadgesForAdmin();
    } catch (e) {
        showError(e.message);
    }
}
async function handleDeleteBadge() {
     const badgeId = $(this).data('badge-id');
     const result = await Swal.fire({
        title: 'แน่ใจหรือไม่?',
        text: "คุณต้องการลบป้ายรางวัลนี้ใช่ไหม?",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'ใช่, ลบเลย!',
        cancelButtonText: 'ยกเลิก'
    });
    if (result.isConfirmed) {
        showLoading('กำลังลบ...');
        try {
            await callApi(`/api/admin/badges/${badgeId}`, {}, 'DELETE');
            showSuccess('ลบป้ายรางวัลเรียบร้อย');
            loadBadgesForAdmin();
        } catch (e) {
            showError(e.message);
        }
    }
}
function handleEditBadge() {
    const badgeId = $(this).data('badge-id');
    const badgeName = $(this).data('badge-name');
    const badgeDesc = $(this).data('badge-desc');
    const badgeUrl = $(this).data('badge-url');

    $('#badge-form-title').text('แก้ไขป้ายรางวัล');
    $('#badge-form')[0].reset();
    $('#badge-id-input').val(badgeId);
    $('#badge-name-input').val(badgeName);
    $('#badge-desc-input').val(badgeDesc);
    $('#badge-image-url-input').val(badgeUrl);
    $('#badge-image-preview').attr('src', badgeUrl);

    AppState.allModals['badge-form'].show();
}

// ===== START: New functions for Idea 3 =====
async function handleViewUserDetails(lineUserId) {
    const modal = AppState.allModals['user-details'];
    if (!modal) return;

    adminSelectedUserId = lineUserId;
    modal.show();

    // Reset tabs to overview
    $('#userDetailTabs .nav-link').removeClass('active');
    $('#userDetailTabs .nav-link[data-bs-target="#udt-overview"]').addClass('active');
    $('.tab-pane').removeClass('show active');
    $('#udt-overview').addClass('show active');

    // Show loading in all containers
    ['#user-details-badges-container','#udt-cards-container','#udt-kyt-container','#udt-hunter-container','#udt-submissions-container'].forEach(id => {
        $(id).html('<div class="text-center py-4"><div class="spinner-border"></div></div>');
    });

    try {
        const [userData, allBadges] = await Promise.all([
            callApi('/api/admin/user-details', { lineUserId }),
            callApi('/api/admin/badges')
        ]);
        const user = userData.user;
        const earnedBadges = Array.isArray(userData.badges) ? userData.badges : [];
        const streak = userData.streak;
        const userCards = Array.isArray(userData.cards) ? userData.cards : [];

        // Stats bar
        $('#detailUserPicture').attr('src', user.pictureUrl || 'https://placehold.co/44x44');
        $('#detailUserName').text(user.fullName);
        $('#detailUserEmployeeId').text('รหัส: ' + (user.employeeId || '-'));
        $('#detailUserScore').text(user.totalScore || 0);
        $('#detailUserCoins').text(user.coinBalance || 0);
        $('#detailUserStreak').text(streak ? streak.currentStreak : 0);
        $('#detailUserLastPlayed').text(streak && streak.lastPlayedDate
            ? new Date(streak.lastPlayedDate).toLocaleDateString('th-TH')
            : '-');

        // Profile edit fields
        $('#admin-edit-fullname').val(user.fullName);
        $('#admin-edit-empid').val(user.employeeId || '');
        // Rebuild options then set selected value (dropdown may not have the right option selected)
        $('#admin-edit-department').html('<option value="">— ไม่ระบุ —</option>' + buildDeptOptions(user.department || ''));

        // Streak input
        $('#adminStreakInput').val(streak ? streak.currentStreak : 0);

        // Badges tab
        const earnedIds = new Set(earnedBadges.map(b => b.badgeId));
        const badgesHtml = allBadges.length === 0
            ? '<p class="text-muted">ยังไม่มีป้ายรางวัลในระบบ</p>'
            : allBadges.map(badge => {
                const isEarned = earnedIds.has(badge.badgeId);
                return `<div class="d-flex justify-content-between align-items-center p-2 border-bottom">
                    <div class="d-flex align-items-center gap-2">
                        <img src="${getFullImageUrl(badge.imageUrl)}" width="32" height="32" class="rounded" onerror="this.src='https://placehold.co/32x32'">
                        <span>${sanitizeHTML(badge.badgeName)}</span>
                    </div>
                    <button class="btn btn-sm ${isEarned ? 'btn-outline-danger' : 'btn-success'} badge-toggle-btn"
                            data-userid="${lineUserId}" data-badgeid="${badge.badgeId}" data-action="${isEarned ? 'revoke' : 'award'}">
                        <i class="fas ${isEarned ? 'fa-times' : 'fa-check'} me-1"></i>${isEarned ? 'เพิกถอน' : 'มอบรางวัล'}
                    </button>
                </div>`;
            }).join('');
        $('#user-details-badges-container').html(badgesHtml);

        // Cards tab
        renderAdminUserCards(userCards);

        // Load award card dropdown
        const allCards = await callApi('/api/admin/cards');
        const cardOptions = allCards.map(c => `<option value="${c.cardId}">${sanitizeHTML(c.cardName)} (${c.rarity})</option>`).join('');
        $('#award-card-select').html('<option value="">-- เลือกการ์ด --</option>' + cardOptions);

    } catch (e) {
        console.error('handleViewUserDetails error:', e);
        showError(e.message || 'ไม่สามารถโหลดข้อมูลได้');
    }

    // Lazy load tabs on click — ใช้ native addEventListener เพราะ Bootstrap 5 fire 'shown.bs.tab' เป็น custom event name
    // jQuery ตีความ dot ใน event name เป็น namespace ทำให้ไม่ match; ต้องใช้ native addEventListener แทน
    const udtTabMap = {
        '#udt-kyt': () => loadUserKytHistory(adminSelectedUserId),
        '#udt-hunter': () => loadUserHunterHistory(adminSelectedUserId),
        '#udt-submissions': () => loadUserSubmissions(adminSelectedUserId),
    };
    Object.entries(udtTabMap).forEach(([target, fn]) => {
        const btn = document.querySelector(`button[data-bs-target="${target}"]`);
        if (btn) {
            const handler = () => fn();
            btn._udtTabHandler && btn.removeEventListener('shown.bs.tab', btn._udtTabHandler);
            btn._udtTabHandler = handler;
            btn.addEventListener('shown.bs.tab', handler);
        }
    });
}

async function loadUserKytHistory(lineUserId) {
    const container = $('#udt-kyt-container');
    container.html('<div class="text-center py-4"><div class="spinner-border"></div></div>');
    try {
        const rows = await callApi('/api/admin/user/kyt-history', { lineUserId });
        if (rows.length === 0) { container.html('<p class="text-muted text-center mt-4">ยังไม่มีประวัติ KYT</p>'); return; }
        const html = rows.map(r => {
            const d = new Date(r.playedAt).toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });
            const badge = r.isCorrect ? '<span class="badge bg-success">ถูก ✅</span>' : '<span class="badge bg-danger">ผิด ❌</span>';
            const answer = r.selectedOption ? `ตอบ: <strong>${r.selectedOption}</strong>${!r.isCorrect && r.correctOption ? ` (เฉลย: ${r.correctOption})` : ''}` : '';
            return `<div class="list-group-item">
                <div class="d-flex justify-content-between align-items-start">
                    <div><p class="mb-1 small fw-bold">${sanitizeHTML(r.questionText)}</p>
                    <small class="text-muted">${answer}</small></div>
                    <div class="text-end">${badge}<br><small class="text-muted">+${r.earnedPoints} คะแนน</small><br><small class="text-muted">${d}</small></div>
                </div>
            </div>`;
        }).join('');
        container.html(`<div class="list-group">${html}</div>`);
    } catch(e) { container.html(`<p class="text-danger">${e.message}</p>`); }
}

async function loadUserHunterHistory(lineUserId) {
    const container = $('#udt-hunter-container');
    container.html('<div class="text-center py-4"><div class="spinner-border"></div></div>');
    try {
        const rows = await callApi('/api/admin/user/hunter-history', { lineUserId });
        if (rows.length === 0) { container.html('<p class="text-muted text-center mt-4">ยังไม่มีประวัติ Hunter</p>'); return; }
        const html = rows.map(r => {
            const d = new Date(r.clearedAt).toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'2-digit' });
            let stars = '';
            for(let i=1; i<=3; i++) stars += i <= r.stars ? '⭐' : '⚫';
            return `<div class="list-group-item d-flex align-items-center gap-3">
                <img src="${getFullImageUrl(r.imageUrl)}" width="48" height="48" class="rounded" style="object-fit:cover;" onerror="this.src='https://placehold.co/48x48'">
                <div class="flex-grow-1"><strong>${sanitizeHTML(r.levelTitle)}</strong><br><small class="text-muted">${d}</small></div>
                <span>${stars}</span>
            </div>`;
        }).join('');
        container.html(`<div class="list-group">${html}</div>`);
    } catch(e) { container.html(`<p class="text-danger">${e.message}</p>`); }
}

async function loadUserSubmissions(lineUserId) {
    const container = $('#udt-submissions-container');
    container.html('<div class="text-center py-4"><div class="spinner-border"></div></div>');
    try {
        const rows = await callApi('/api/admin/user/submissions', { lineUserId });
        if (rows.length === 0) { container.html('<p class="text-muted text-center mt-4">ยังไม่มีการส่งงาน</p>'); return; }

        const statusMap = {
            pending:  { cls: 'bg-warning text-dark', label: 'รอตรวจ',  icon: 'fa-clock' },
            approved: { cls: 'bg-success',           label: 'อนุมัติ', icon: 'fa-check' },
            rejected: { cls: 'bg-danger',            label: 'ปฏิเสธ',  icon: 'fa-times' }
        };

        const approved = rows.filter(r => r.status === 'approved').length;
        const totalPts = rows.filter(r => r.status === 'approved').reduce((s, r) => s + (r.points || 0), 0);

        const summary = `<div class="d-flex gap-3 mb-3 px-1">
            <span class="text-muted small">ทั้งหมด <strong>${rows.length}</strong> รายการ</span>
            <span class="text-muted small">อนุมัติ <strong class="text-success">${approved}</strong></span>
            <span class="text-muted small">คะแนนรวม <strong class="text-warning">${totalPts}</strong></span>
        </div>`;

        const html = rows.map((r, i) => {
            const d = new Date(r.createdAt).toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'2-digit' });
            const st = statusMap[r.status] || { cls: 'bg-secondary', label: r.status, icon: 'fa-question' };
            const statusBadge = `<span class="badge ${st.cls}"><i class="fas ${st.icon} me-1"></i>${st.label}</span>`;
            const pointsBadge = r.status === 'approved' && r.points
                ? `<span class="badge bg-warning text-dark ms-1">+${r.points} คะแนน</span>` : '';
            const img = r.imageUrl
                ? `<img src="${getFullImageUrl(r.imageUrl)}" class="udt-sub-thumb" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0;cursor:pointer;"
                       onclick="window.open('${getFullImageUrl(r.imageUrl)}','_blank')">`
                : `<div style="width:72px;height:72px;border-radius:8px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                       <i class="fas fa-file-alt text-muted"></i></div>`;
            const desc = sanitizeHTML(r.description || '');
            const descId = `sub-desc-${i}`;
            const descBlock = desc.length > 120
                ? `<p class="small text-muted mb-1 udt-sub-desc" id="${descId}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${desc}</p>
                   <a href="#" class="small text-primary udt-expand-link" data-target="${descId}" style="user-select:none;">ดูเพิ่มเติม</a>`
                : `<p class="small text-muted mb-0">${desc}</p>`;

            return `<div class="udt-sub-card">
                <div class="d-flex gap-3">
                    ${img}
                    <div class="flex-grow-1 min-width-0">
                        <div class="d-flex align-items-start justify-content-between gap-2 mb-1">
                            <strong class="small text-truncate">${sanitizeHTML(r.activityTitle)}</strong>
                            <div class="d-flex flex-column align-items-end gap-1" style="flex-shrink:0;">
                                ${statusBadge}${pointsBadge}
                                <small class="text-muted">${d}</small>
                            </div>
                        </div>
                        ${descBlock}
                    </div>
                </div>
            </div>`;
        }).join('');

        container.html(summary + `<div class="udt-sub-list">${html}</div>`);

        // expand/collapse
        container.off('click.expand').on('click.expand', '.udt-expand-link', function(e) {
            e.preventDefault();
            const el = document.getElementById($(this).data('target'));
            if (!el) return;
            const expanded = el.style.webkitLineClamp === 'unset';
            el.style.cssText = expanded
                ? 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;'
                : 'display:block;-webkit-line-clamp:unset;overflow:visible;';
            $(this).text(expanded ? 'ดูเพิ่มเติม' : 'ย่อ');
        });
    } catch(e) { container.html(`<p class="text-danger">${e.message}</p>`); }
}

async function handleToggleBadge() {
    const btn = $(this);
    const userId = btn.data('userid');
    const badgeId = btn.data('badgeid');
    const action = btn.data('action');

    btn.prop('disabled', true).html('<span class="spinner-border spinner-border-sm"></span>');
    
    try {
        const endpoint = action === 'award' ? '/api/admin/award-badge' : '/api/admin/revoke-badge';
        await callApi(endpoint, { lineUserId: userId, badgeId: badgeId }, 'POST');
        
        const newAction = action === 'award' ? 'revoke' : 'award';
        const newText = newAction === 'revoke' ? 'เพิกถอน' : 'มอบรางวัล';
        const newClass = newAction === 'revoke' ? 'btn-outline-danger' : 'btn-success';
        const oldClass = newAction === 'revoke' ? 'btn-success' : 'btn-outline-danger';
        const newIcon = newAction === 'revoke' ? 'fa-times' : 'fa-check';
        
        btn.data('action', newAction)
           .html(`<i class="fas ${newIcon} me-1"></i> ${newText}`)
           .removeClass(oldClass)
           .addClass(newClass);

    } catch (e) {
        showError(e.message);
        // Reset button to original state on error
        const originalText = action === 'award' ? 'มอบรางวัล' : 'เพิกถอน';
        btn.html(`<i class="fas ${action === 'award' ? 'fa-check' : 'fa-times'} me-1"></i> ${originalText}`);
    } finally {
        btn.prop('disabled', false);
    }
}
// ===== END: New functions for Idea 3 =====

// loadAdminUserDetails — ใช้ handleViewUserDetails แทนเพื่อไม่ให้ code ซ้ำ
async function loadAdminUserDetails(lineUserId) {
    await handleViewUserDetails(lineUserId);
}

async function loadAdminDashboard() {
    try {
        const stats = await callApi('/api/admin/dashboard-stats');
        $('#stat-pending-count').text(stats.pendingCount);
        $('#stat-user-count').text(stats.userCount);
        $('#stat-activities-count').text(stats.activeActivitiesCount);
        $('#quick-action-pending-count').text(stats.pendingCount);
    } catch (e) {
        console.error("Failed to load dashboard stats:", e);
        $('#dashboard-stats').html('<p class="text-danger">ไม่สามารถโหลดข้อมูลสรุปได้</p>');
    }
}

async function loadAdminStats() {
    const container = $('#stats-container');
    $('#stats-loading').show();
    container.empty();
    try {
        const [stats, chartData] = await Promise.all([
            callApi('/api/admin/stats'),
            callApi('/api/admin/chart-data')
        ]);

        renderAdminChart(chartData);

        const statsHtml = `
            <div class="col-md-6"><div class="card stat-card shadow-sm"><div class="card-body"><h6 class="card-subtitle mb-2 text-muted">ผู้ใช้งานทั้งหมด</h6><h4 class="card-title">${stats.totalUsers} คน</h4></div></div></div>
            <div class="col-md-6"><div class="card stat-card shadow-sm"><div class="card-body"><h6 class="card-subtitle mb-2 text-muted">รายงานทั้งหมด</h6><h4 class="card-title">${stats.totalSubmissions} รายการ</h4></div></div></div>
            <div class="col-md-6"><div class="card stat-card shadow-sm"><div class="card-body"><h6 class="card-subtitle mb-2 text-muted">รายงานวันนี้</h6><h4 class="card-title">${stats.submissionsToday} รายการ</h4></div></div></div>
            <div class="col-md-6"><div class="card stat-card shadow-sm"><div class="card-body"><h6 class="card-subtitle mb-2 text-muted">กิจกรรมที่ถูกรายงานมากที่สุด</h6><h5 class="card-title small">${sanitizeHTML(stats.mostReportedActivity)}</h5></div></div></div>`;
        container.html(statsHtml);
    } catch(e) { 
        container.html('<p class="text-center text-danger">ไม่สามารถโหลดข้อมูลสรุปได้</p>'); 
    } finally { 
        $('#stats-loading').hide(); 
    }
}
// ===== DASHBOARD ANALYTICS =====
let _analyticsWeeklyChart = null;
let _analyticsApprovalChart = null;

async function loadAdminAnalytics() {
    $('#analytics-loading').show();
    $('#analytics-content').hide();
    try {
        const data = await callApi('/api/admin/analytics');

        // Summary cards
        const summaryHtml = [
            { label: 'รายงานทั้งหมด', value: data.totalSubmissions, icon: 'fa-file-alt', color: 'primary' },
            { label: 'อนุมัติแล้ว', value: data.approvedCount, icon: 'fa-check-circle', color: 'success' },
            { label: 'รอตรวจ', value: data.pendingCount, icon: 'fa-clock', color: 'warning' },
            { label: 'ผู้ใช้งาน', value: data.totalUsers, icon: 'fa-users', color: 'info' }
        ].map(c => `
            <div class="col-6 col-md-3">
                <div class="card shadow-sm text-center border-0">
                    <div class="card-body py-3">
                        <i class="fas ${c.icon} fa-2x text-${c.color} mb-2"></i>
                        <h4 class="fw-bold mb-0">${c.value}</h4>
                        <small class="text-muted">${c.label}</small>
                    </div>
                </div>
            </div>`).join('');
        $('#analytics-summary-row').html(summaryHtml);

        // Weekly chart
        if (_analyticsWeeklyChart) _analyticsWeeklyChart.destroy();
        const weekCtx = document.getElementById('analytics-weekly-chart').getContext('2d');
        _analyticsWeeklyChart = new Chart(weekCtx, {
            type: 'bar',
            data: {
                labels: data.weeklyTrend.map(w => w.label),
                datasets: [{
                    label: 'รายงานที่ส่ง',
                    data: data.weeklyTrend.map(w => w.count),
                    backgroundColor: 'rgba(6,199,85,0.7)',
                    borderColor: '#06C755',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });

        // Approval rate donut
        if (_analyticsApprovalChart) _analyticsApprovalChart.destroy();
        const approvalCtx = document.getElementById('analytics-approval-chart').getContext('2d');
        _analyticsApprovalChart = new Chart(approvalCtx, {
            type: 'doughnut',
            data: {
                labels: ['อนุมัติ', 'รอตรวจ', 'ปฏิเสธ'],
                datasets: [{ data: [data.approvedCount, data.pendingCount, data.rejectedCount],
                    backgroundColor: ['#06C755','#fbbf24','#ef4444'], borderWidth: 2 }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });

        // Top reporters
        const topHtml = data.topReporters.map((r, i) => `
            <div class="list-group-item d-flex align-items-center gap-3">
                <span class="fw-bold text-muted" style="min-width:24px;">${i + 1}</span>
                <img src="${r.pictureUrl || 'https://placehold.co/36x36'}" width="36" height="36" class="rounded-circle" style="object-fit:cover;">
                <div class="flex-grow-1">
                    <strong>${sanitizeHTML(r.fullName)}</strong>
                    <small class="text-muted d-block">${r.department ? sanitizeHTML(r.department) : 'ไม่ระบุแผนก'}</small>
                </div>
                <span class="badge bg-success rounded-pill">${r.count} รายงาน</span>
            </div>`).join('');
        $('#analytics-top-reporters').html(`<div class="list-group list-group-flush">${topHtml}</div>`);

        $('#analytics-loading').hide();
        $('#analytics-content').show();
    } catch(e) {
        $('#analytics-loading').html(`<p class="text-danger">${e.message}</p>`);
    }
}

// ===== DEPARTMENT SAFETY SCORES =====
let _deptChart = null;

async function loadDepartmentScores() {
    $('#dept-loading').show();
    $('#dept-content').hide();
    try {
        const rows = await callApi('/api/admin/department-scores');
        if (!rows.length) {
            $('#dept-loading').html('<p class="text-muted text-center mt-4">ยังไม่มีข้อมูลแผนก กรุณาอัพเดตแผนกให้ผู้ใช้ก่อน</p>');
            return;
        }

        // Chart
        if (_deptChart) _deptChart.destroy();
        const ctx = document.getElementById('dept-score-chart').getContext('2d');
        _deptChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: rows.map(r => r.department),
                datasets: [{
                    label: 'คะแนนเฉลี่ย',
                    data: rows.map(r => r.avgScore),
                    backgroundColor: rows.map((_, i) => `hsl(${140 + i * 25},65%,50%)`),
                    borderRadius: 6
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true } } }
        });

        // Table
        const tableHtml = `<table class="table table-sm table-hover mb-0">
            <thead class="table-dark"><tr>
                <th>แผนก</th><th class="text-center">สมาชิก</th>
                <th class="text-center">คะแนนเฉลี่ย</th><th class="text-center">รายงานรวม</th>
            </tr></thead><tbody>
            ${rows.map(r => `<tr>
                <td class="fw-semibold">${sanitizeHTML(r.department)}</td>
                <td class="text-center">${r.memberCount}</td>
                <td class="text-center"><span class="badge bg-success">${Number(r.avgScore).toFixed(1)}</span></td>
                <td class="text-center">${r.totalSubmissions}</td>
            </tr>`).join('')}
            </tbody></table>`;
        $('#dept-table-container').html(`<div class="card shadow-sm"><div class="card-header fw-bold">ตารางสรุปคะแนนแผนก</div><div class="card-body p-0">${tableHtml}</div></div>`);

        $('#dept-loading').hide();
        $('#dept-content').show();
    } catch(e) {
        $('#dept-loading').html(`<p class="text-danger">${e.message}</p>`);
    }
}

// ===== EXPORT =====
async function handleExportCSV() {
    const status = $('#export-status-select').val();
    const from = $('#export-date-from').val();
    const to = $('#export-date-to').val();
    const params = new URLSearchParams({ status, from, to, requesterId: AppState.lineProfile.userId });
    window.location.href = `/api/admin/export/submissions?${params.toString()}`;
}

function handleExportPDF() {
    const status = $('#export-status-select').val();
    const from = $('#export-date-from').val();
    const to = $('#export-date-to').val();
    AppState.allModals['admin-export'].hide();
    Swal.fire({ title: 'เตรียม PDF...', text: 'ระบบจะเปิดหน้าพิมพ์ให้อัตโนมัติ กดพิมพ์เป็น PDF ได้เลย', icon: 'info',
        confirmButtonText: 'ตกลง' }).then(() => {
        const params = new URLSearchParams({ status, from, to, requesterId: AppState.lineProfile.userId });
        window.open(`/api/admin/export/submissions/print?${params.toString()}`, '_blank');
    });
}

// ===== ADMIN AUDIT LOG =====
const AUDIT_ACTION_LABELS = {
    APPROVE_SUBMISSION: { label: 'Approve รายงาน',  cls: 'success' },
    REJECT_SUBMISSION:  { label: 'Reject รายงาน',   cls: 'danger'  },
    DELETE_SUBMISSION:  { label: 'ลบรายงาน',         cls: 'dark'    },
    ADD_SCORE:          { label: 'เพิ่มคะแนน',       cls: 'primary' },
    DEDUCT_SCORE:       { label: 'หักคะแนน',          cls: 'warning' },
    ADD_COINS:          { label: 'เพิ่มเหรียญ',       cls: 'info'    },
    DEDUCT_COINS:       { label: 'หักเหรียญ',          cls: 'warning' },
    UPDATE_STREAK:      { label: 'แก้ Streak',        cls: 'secondary'},
    AWARD_BADGE:        { label: 'มอบป้าย',           cls: 'success' },
    REVOKE_BADGE:       { label: 'เพิกถอนป้าย',       cls: 'danger'  },
    AWARD_CARD:         { label: 'มอบการ์ด',          cls: 'primary' },
    UPDATE_PROFILE:     { label: 'แก้ Profile',       cls: 'secondary'},
};

async function loadAdminAuditLogs(page = 1) {
    const action   = $('#audit-filter-action').val();
    const dateFrom = $('#audit-filter-from').val();
    const dateTo   = $('#audit-filter-to').val();

    const payload = { page, limit: 50 };
    if (action)   payload.action   = action;
    if (dateFrom) payload.dateFrom = dateFrom;
    if (dateTo)   payload.dateTo   = dateTo;

    $('#audit-log-tbody').html('<tr><td colspan="6" class="text-center"><span class="spinner-border spinner-border-sm"></span> กำลังโหลด...</td></tr>');

    try {
        const json = await callApi('/api/admin/audit-logs', payload);
        const { rows, total, limit } = json;
        const totalPages = Math.ceil(total / limit);

        $('#audit-total-label').text(`แสดง ${rows.length} จาก ${total} รายการ | หน้า ${page}/${totalPages || 1}`);
        $('#btn-audit-prev').data('page', page).data('total', total).prop('disabled', page <= 1);
        $('#btn-audit-next').data('page', page).data('total', total).prop('disabled', page >= totalPages);

        if (!rows.length) {
            $('#audit-log-tbody').html('<tr><td colspan="6" class="text-center text-muted">ไม่พบข้อมูล</td></tr>');
            return;
        }

        const offset = (page - 1) * limit;
        const html = rows.map((r, i) => {
            const meta = AUDIT_ACTION_LABELS[r.action] || { label: r.action, cls: 'secondary' };
            const ts = new Date(r.createdAt).toLocaleString('th-TH');
            let detail = '';
            try {
                const d = typeof r.detail === 'string' ? JSON.parse(r.detail) : (r.detail || {});
                detail = Object.entries(d).map(([k, v]) => `<span class="text-muted">${k}:</span> <b>${sanitizeHTML(String(v))}</b>`).join(' · ');
            } catch(_) {}
            return `<tr>
                <td class="text-muted">${offset + i + 1}</td>
                <td style="white-space:nowrap;">${ts}</td>
                <td><small>${sanitizeHTML(r.adminName || r.adminId)}</small></td>
                <td><span class="badge bg-${meta.cls}">${meta.label}</span></td>
                <td><small class="text-muted">${sanitizeHTML(r.targetName || r.targetId || '')}</small></td>
                <td><small>${detail}</small></td>
            </tr>`;
        }).join('');

        $('#audit-log-tbody').html(html);
    } catch(e) {
        $('#audit-log-tbody').html(`<tr><td colspan="6" class="text-danger text-center">${e.message}</td></tr>`);
    }
}

// แก้ไขฟังก์ชันนี้ทั้งฟังก์ชัน
async function loadPendingSubmissions() {
    const container = $('#admin-reports-container');
    $('#reports-loading').show();
    $('#no-reports-message').hide();
    container.empty();
    try {
        const subs = await callApi('/api/admin/submissions/pending');
        $('#pending-count-modal').text(subs.length);

        if (subs.length === 0) {
            $('#no-reports-message').show();
            $('#bulk-action-bar').hide();
        } else {
            $('#bulk-action-bar').css('display', 'flex');
            subs.forEach(s => {
                // ----- START: ส่วนที่แก้ไข -----
                let imageHtmlBlock = '';
                let contentClass = 'col-12'; // เริ่มต้นให้ข้อความเต็มความกว้าง

                // ตรวจสอบว่ามี imageUrl หรือไม่
                if (s.imageUrl) {
                    // ถ้ามีรูป ให้สร้าง HTML บล็อกของรูปภาพ
                    imageHtmlBlock = `
                        <div class="col-md-5 col-lg-4">
                            <img src="${getFullImageUrl(s.imageUrl)}" class="img-fluid rounded-start h-100" style="object-fit: cover;" alt="Submission Image">
                        </div>
                    `;
                    // และปรับขนาดคลาสของส่วนเนื้อหา
                    contentClass = 'col-md-7 col-lg-8';
                }

                // นำตัวแปรที่สร้างมาประกอบร่างเป็น Card ที่สมบูรณ์
                const cardHtml = `
                    <div class="card shadow-sm mb-3 report-card" id="report-card-${s.submissionId}">
                        <div class="row g-0">
                            ${imageHtmlBlock}
                            <div class="${contentClass}">
                                <div class="card-body">
                                    <div class="d-flex align-items-center gap-2 mb-2">
                                        <input type="checkbox" class="report-select-cb form-check-input mt-0 flex-shrink-0" data-id="${s.submissionId}">
                                        <img src="${s.pictureUrl || 'https://placehold.co/32x32'}" width="32" height="32" class="rounded-circle" style="object-fit:cover;">
                                        <div>
                                            <h6 class="mb-0 fw-bold">${sanitizeHTML(s.fullName)}</h6>
                                            <small class="text-muted">${new Date(s.createdAt).toLocaleString('th-TH')}</small>
                                        </div>
                                    </div>
                                    <div class="report-description-formatted small border-start border-3 border-primary ps-2 mb-3">${formatReportDescription(s.description)}</div>
                                    <div class="d-flex align-items-center flex-wrap gap-2">
                                        <label class="small">ให้คะแนน:</label>
                                        <input type="number" id="score-input-${s.submissionId}" class="form-control form-control-sm" value="10" min="0" style="width: 80px;">
                                        <button class="btn btn-success btn-sm btn-approve flex-grow-1" data-id="${s.submissionId}">
                                            <i class="fas fa-check"></i> อนุมัติ
                                        </button>
                                        <button class="btn btn-danger btn-sm btn-reject flex-grow-1" data-id="${s.submissionId}">
                                            <i class="fas fa-times"></i> ปฏิเสธ
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
                // ----- END: ส่วนที่แก้ไข -----
                container.append(cardHtml);
            });
        }
    } catch (e) {
        console.error('loadPendingSubmissions error:', e);
        container.html('<p class="text-center text-danger mt-4">ไม่สามารถโหลดรายงานได้ กรุณาลองใหม่</p>');
    } finally {
        $('#reports-loading').hide();
    }
}
async function loadAllActivitiesForAdmin() {
    const list = $('#activities-list-admin');
    list.html('<div class="spinner-border"></div>');
    try {
        const acts = await callApi('/api/admin/activities');
        displayActivitiesUIForAdmin(acts);
    } catch(e) {
        list.html('<p class="text-danger">ไม่สามารถโหลดกิจกรรมได้</p>');
    }
}
function renderFilteredBadges(badges, query) {
    const list = $('#badges-list');
    list.empty();
    const filtered = query
        ? badges.filter(b => b.badgeName.toLowerCase().includes(query.toLowerCase()))
        : badges;
    if (filtered.length === 0) {
        list.html('<p class="text-center text-muted my-4">ไม่พบป้ายรางวัลที่ค้นหา</p>');
        return;
    }
    filtered.forEach(b => {
        const html = `
            <div class="col-6 col-md-4 col-lg-3 mb-3">
                <div class="card h-100 shadow-sm text-center admin-badge-card">
                    <div class="card-body">
                        <img src="${getFullImageUrl(b.imageUrl)}" class="badge-icon mb-2" onerror="this.onerror=null;this.src='https://placehold.co/60x60/e9ecef/6c757d?text=Badge';" alt="${sanitizeHTML(b.badgeName)}">
                        <h6 class="fw-bold mb-1">${sanitizeHTML(b.badgeName)}</h6>
                        <small class="text-muted d-block mb-3 preserve-whitespace">${sanitizeHTML(b.description)}</small>
                        <div class="d-flex justify-content-center gap-2">
                            <button class="btn btn-sm btn-outline-primary btn-edit-badge"
                                data-badge-id="${b.badgeId}"
                                data-badge-name="${sanitizeHTML(b.badgeName)}"
                                data-badge-desc="${sanitizeHTML(b.description)}"
                                data-badge-url="${getFullImageUrl(b.imageUrl)}">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-danger delete-badge-btn" data-badge-id="${b.badgeId}">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>`;
        list.append(html);
    });
}

async function loadBadgesForAdmin() {
    const list = $('#badges-list');
    list.html('<div class="text-center my-4"><div class="spinner-border text-success"></div><p class="text-muted mt-2">กำลังโหลดป้ายรางวัล...</p></div>');
    try {
        const badges = await callApi('/api/admin/badges');
        AppState._cachedBadges = badges;
        if (badges.length === 0) {
            list.html('<p class="text-center text-muted my-4">ยังไม่มีป้ายรางวัลในระบบ</p>');
        } else {
            const query = $('#badge-search-input').val() || '';
            renderFilteredBadges(badges, query);
            $('#badge-search-input').off('input.bsearch').on('input.bsearch', function() {
                renderFilteredBadges(AppState._cachedBadges || [], $(this).val());
            });
        }
    } catch (e) {
        list.html('<p class="text-danger">ไม่สามารถโหลดป้ายรางวัลได้</p>');
    }
}

// ===== START: Updated User Search/Load functions for Idea 3 =====
async function loadUsersForAdmin() {
    AppState.adminUsers.currentSearch = ''; // รีเซ็ตคำค้นหา
    await fetchAdminUsers(1, ''); // เรียกใช้ฟังก์ชันใหม่เพื่อโหลดหน้า 1
}

async function searchUsersForAdmin(query) {
    AppState.adminUsers.currentSearch = query; // เก็บคำค้นหาปัจจุบัน
    await fetchAdminUsers(1, query); // เรียกใช้ฟังก์ชันใหม่เพื่อโหลดหน้า 1 ของผลการค้นหา
}

// ===== START: แทนที่ฟังก์ชัน fetchAdminUsers เดิมทั้งหมดด้วยอันนี้ =====
async function fetchAdminUsers(page, query, isLoadMore = false) {
    const resultsContainer = $('#user-search-results');
    const loadMoreContainer = $('#users-load-more-container');
    const loadMoreBtn = $('#users-load-more-btn');

    // โหลดครั้งแรก (ไม่ใช่ load more)
    if (!isLoadMore) {
        resultsContainer.html(
            '<div class="text-center my-4"><div class="spinner-border text-success"></div></div>'
        );
        AppState.adminUsers.currentPage = 1;
        AppState.adminUsers.hasMore = true;
    }

    // ถ้า set ว่าไม่มีข้อมูลเพิ่มแล้ว ก็ไม่ต้องโหลด
    if (!AppState.adminUsers.hasMore) return;

    loadMoreBtn.prop('disabled', true);

    try {
        // 1) ดึงรายชื่อผู้ใช้จาก /api/admin/users (ยังไม่มีจำนวนป้าย)
        const users = await callApi('/api/admin/users', {
            search: query,
            page: page,
            sortBy: AppState.adminUsers.currentSort
        });

        if (!isLoadMore) {
            resultsContainer.empty();
        }

        if (!users || users.length === 0) {
            if (!isLoadMore) {
                resultsContainer.html('<p class="text-center text-muted my-4">ไม่พบผู้ใช้งาน</p>');
                loadMoreContainer.hide();
                $('#user-count-label').text('');
            }
            AppState.adminUsers.hasMore = false;
            return;
        }

        // อัปเดต cache และจำนวน user
        if (!isLoadMore) {
            AppState._cachedAdminUsers = users;
            $('#user-count-label').text(`พบ ${users.length} คน`);
        } else {
            AppState._cachedAdminUsers = (AppState._cachedAdminUsers || []).concat(users);
        }

        // 2) แสดงผลใน list (badgeCount มาจาก API แล้ว ไม่ต้อง fetch แยก)
        renderUserListForAdmin(users, resultsContainer);

        // 4) จัดการ state สำหรับปุ่ม "โหลดเพิ่มเติม"
        if (users.length < 30) {
            AppState.adminUsers.hasMore = false;
            loadMoreContainer.hide();
        } else {
            AppState.adminUsers.currentPage++;
            loadMoreContainer.show();
        }
    } catch (e) {
        console.error('fetchAdminUsers error:', e);
        if (!isLoadMore) {
            resultsContainer.html(
                '<p class="text-center text-danger my-4">ไม่สามารถโหลดข้อมูลได้</p>'
            );
        }
    } finally {
        loadMoreBtn.prop('disabled', false);
    }
}
// ===== END: แทนที่ฟังก์ชัน fetchAdminUsers เดิมด้วยอันนี้ =====

// ฟังก์ชัน renderUserListForAdmin (ฉบับอัปเดต: เพิ่มปุ่มแก้ไข)
function renderUserListForAdmin(users, container) {
    users.forEach(user => {
        // พยายามดึงจำนวนป้ายจากหลาย ๆ ฟิลด์
        const badgeCount =
            typeof user.badgeCount === 'number' ? user.badgeCount :
            typeof user.badgesCount === 'number' ? user.badgesCount :
            Array.isArray(user.badges) ? user.badges.length : 0;

        // ⭐ เข้ารหัสข้อมูล User เพื่อฝังในปุ่ม (ป้องกัน Error เครื่องหมายคำพูดตีกัน)
        const userDataSafe = encodeURIComponent(JSON.stringify(user));

        const html = `
            <div class="card shadow-sm mb-2 user-card" style="cursor: pointer;" data-userid="${user.lineUserId}">
                <div class="card-body p-2">
                    <div class="d-flex align-items-center">
                        <img src="${getFullImageUrl(user.pictureUrl) || 'https://placehold.co/45x45'}"
                             class="rounded-circle me-3" width="45" height="45" alt="Profile">
                        
                        <div class="flex-grow-1">
                            <h6 class="fw-bold mb-0">${sanitizeHTML(user.fullName)}</h6>
                            <small class="text-muted">
                                รหัส: ${sanitizeHTML(user.employeeId)}
                                | คะแนน: ${user.totalScore}
                                | <i class="fas fa-certificate text-warning"></i> ${badgeCount} ป้าย
                            </small>
                        </div>

                        <button class="btn btn-sm btn-outline-warning btn-edit-user-full me-3" 
                                data-user="${userDataSafe}"
                                title="แก้ไขข้อมูล">
                            <i class="fas fa-edit"></i>
                        </button>

                        <i class="fas fa-chevron-right text-muted"></i>
                    </div>
                </div>
            </div>`;
        container.append(html);
    });
}

// =============================
// ADMIN: ปรับคะแนนผู้ใช้ (เวอร์ชันแก้ไขสมบูรณ์)
// =============================
$(document).on("click", "#adminApplyScoreBtn", async function () {
    if (!adminSelectedUserId) {
        return Swal.fire("ไม่พบผู้ใช้ที่เลือก", "", "warning");
    }

    const delta = Number($("#adminScoreDeltaInput").val());
    const mode = $("input[name='adminScoreMode']:checked").val(); // add / sub

    if (!delta || delta <= 0 || !Number.isInteger(delta)) {
        return Swal.fire("กรุณากรอกจำนวนคะแนนเป็นตัวเลขจำนวนเต็มที่มากกว่า 0", "", "warning");
    }
    if (delta > 10000) {
        return Swal.fire("จำนวนคะแนนมากเกินไป", "ไม่สามารถปรับเกิน 10,000 คะแนนต่อครั้ง", "warning");
    }

    const deltaScore = mode === "sub" ? -Math.abs(delta) : Math.abs(delta);
    const userName = $('#detailUserName').text() || 'ผู้ใช้นี้';
    const actionLabel = mode === "sub" ? `หัก ${delta} คะแนน` : `เพิ่ม ${delta} คะแนน`;
    const confirmResult = await Swal.fire({
        title: `ยืนยันการปรับคะแนน?`,
        html: `<b>${userName}</b><br>${actionLabel}`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: mode === "sub" ? '#dc3545' : '#06C755',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'ยืนยัน',
        cancelButtonText: 'ยกเลิก'
    });
    if (!confirmResult.isConfirmed) return;

    // UI Loading
    const applyBtnText = $("#adminScoreBtnText");
    const loadingIcon = $("#adminScoreBtnLoading");
    applyBtnText.addClass("d-none");
    loadingIcon.removeClass("d-none");

    try {
        // callApi() คืนค่าเฉพาะ result.data → ไม่มี result.status
        await callApi('/api/admin/users/update-score', {
            lineUserId: adminSelectedUserId,
            deltaScore: deltaScore,
        }, 'POST');

        // โหลดข้อมูลใหม่หลังอัปเดตคะแนน
        await loadAdminUserDetails(adminSelectedUserId);

        Swal.fire({
            icon: "success",
            title: "อัปเดตคะแนนสำเร็จ!",
            timer: 1500,
            showConfirmButton: false
        });

    } catch (err) {
        Swal.fire("เกิดข้อผิดพลาด", err.message, "error");
        console.error("Score update failed:", err);
    }

    // UI revert
    applyBtnText.removeClass("d-none");
    loadingIcon.addClass("d-none");
});

// B-1: ปรับ Coins
$(document).on('click', '#adminApplyCoinBtn', async function() {
    if (!adminSelectedUserId) return Swal.fire('ไม่พบผู้ใช้', '', 'warning');
    const delta = Number($('#adminCoinDeltaInput').val());
    const mode = $("input[name='adminCoinMode']:checked").val();
    if (!delta || delta <= 0 || !Number.isInteger(delta)) {
        return Swal.fire('กรุณากรอกจำนวนเหรียญเป็นตัวเลขจำนวนเต็มที่มากกว่า 0', '', 'warning');
    }
    if (delta > 10000) return Swal.fire('จำนวนมากเกินไป', 'ไม่เกิน 10,000 ต่อครั้ง', 'warning');
    const deltaCoins = mode === 'sub' ? -Math.abs(delta) : Math.abs(delta);
    const name = $('#detailUserName').text();
    const label = mode === 'sub' ? `หัก ${delta} เหรียญ` : `เพิ่ม ${delta} เหรียญ`;
    const conf = await Swal.fire({ title: 'ยืนยัน?', html: `<b>${name}</b><br>${label}`, icon: 'question', showCancelButton: true, confirmButtonColor: mode === 'sub' ? '#dc3545' : '#06C755', cancelButtonColor: '#6c757d', confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' });
    if (!conf.isConfirmed) return;
    try {
        const res = await callApi('/api/admin/user/update-coins', { lineUserId: adminSelectedUserId, deltaCoins }, 'POST');
        $('#detailUserCoins').text(res.newBalance);
        Swal.fire({ icon: 'success', title: 'อัปเดตเหรียญสำเร็จ!', timer: 1500, showConfirmButton: false });
        $('#adminCoinDeltaInput').val('');
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
});

// B-7: ตั้งค่า Streak
$(document).on('click', '#adminApplyStreakBtn', async function() {
    if (!adminSelectedUserId) return;
    const newStreak = Number($('#adminStreakInput').val());
    if (isNaN(newStreak) || newStreak < 0) return Swal.fire('กรุณากรอกจำนวนวันที่ถูกต้อง', '', 'warning');
    const name = $('#detailUserName').text();
    const conf = await Swal.fire({ title: 'ยืนยันการตั้ง Streak?', html: `<b>${name}</b><br>Streak = ${newStreak} วัน`, icon: 'question', showCancelButton: true, confirmButtonColor: '#0dcaf0', cancelButtonColor: '#6c757d', confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' });
    if (!conf.isConfirmed) return;
    try {
        await callApi('/api/admin/user/update-streak', { lineUserId: adminSelectedUserId, newStreak }, 'POST');
        $('#detailUserStreak').text(newStreak);
        Swal.fire({ icon: 'success', title: 'ตั้ง Streak สำเร็จ!', timer: 1500, showConfirmButton: false });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
});

// B-9: บันทึก Profile
$(document).on('click', '#adminSaveProfileBtn', async function() {
    if (!adminSelectedUserId) return;
    const fullName = $('#admin-edit-fullname').val().trim();
    const employeeId = $('#admin-edit-empid').val().trim();
    const department = $('#admin-edit-department').val().trim();
    if (!fullName) return Swal.fire('กรุณากรอกชื่อ', '', 'warning');
    try {
        await callApi('/api/admin/user/update-profile', { lineUserId: adminSelectedUserId, fullName, employeeId, department }, 'POST');
        $('#detailUserName').text(fullName);
        $('#detailUserEmployeeId').text('รหัส: ' + (employeeId || '-'));
        Swal.fire({ icon: 'success', title: 'บันทึกข้อมูลสำเร็จ!', timer: 1500, showConfirmButton: false });
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
});

// B-8: Show/hide award card form
$(document).on('click', '#adminAwardCardBtn', function() {
    $('#award-card-form').toggle();
});
$(document).on('click', '#adminCancelAwardCardBtn', function() {
    $('#award-card-form').hide();
});
$(document).on('click', '#adminConfirmAwardCardBtn', async function() {
    const cardId = $('#award-card-select').val();
    if (!cardId || !adminSelectedUserId) return Swal.fire('กรุณาเลือกการ์ด', '', 'warning');
    const cardName = $('#award-card-select option:selected').text();
    const name = $('#detailUserName').text();
    const conf = await Swal.fire({ title: 'ยืนยันการมอบการ์ด?', html: `<b>${name}</b> จะได้รับ<br><b>${cardName}</b>`, icon: 'question', showCancelButton: true, confirmButtonColor: '#06C755', cancelButtonColor: '#6c757d', confirmButtonText: 'มอบเลย', cancelButtonText: 'ยกเลิก' });
    if (!conf.isConfirmed) return;
    try {
        await callApi('/api/admin/award-card', { lineUserId: adminSelectedUserId, cardId }, 'POST');
        $('#award-card-form').hide();
        Swal.fire({ icon: 'success', title: 'มอบการ์ดสำเร็จ!', timer: 1500, showConfirmButton: false });
        // reload cards tab
        loadUserCardsTab(adminSelectedUserId);
    } catch(e) { Swal.fire('Error', e.message, 'error'); }
});

// helper: render cards sorted by rarity UR>SR>R>C with total count header
function renderAdminUserCards(userCards) {
    if (userCards.length === 0) {
        $('#udt-cards-container').html('<p class="text-muted col-12">ยังไม่มีการ์ด</p>');
        return;
    }
    const rarityOrder = { UR: 0, SR: 1, R: 2, C: 3 };
    const sorted = [...userCards].sort((a, b) => (rarityOrder[a.rarity] ?? 9) - (rarityOrder[b.rarity] ?? 9));
    const totalQty = userCards.reduce((s, c) => s + (c.qty || 1), 0);
    const totalUniq = userCards.length;
    const cardHtml = sorted.map(c => {
        let rarityClass = 'bg-secondary';
        if (c.rarity === 'R') rarityClass = 'bg-info text-dark';
        if (c.rarity === 'SR') rarityClass = 'bg-danger';
        if (c.rarity === 'UR') rarityClass = 'bg-warning text-dark';
        return `<div class="col-6 col-md-3 col-lg-2">
            <div class="card h-100 shadow-sm text-center">
                <img src="${getFullImageUrl(c.imageUrl)}" class="card-img-top" style="height:100px;object-fit:contain;padding:8px;background:#f8f9fa;">
                <div class="card-body p-2">
                    <span class="badge ${rarityClass} mb-1">${c.rarity}</span>
                    <p class="small fw-bold mb-0 text-truncate">${sanitizeHTML(c.cardName)}</p>
                    <small class="text-muted">x${c.qty}</small>
                </div>
            </div>
        </div>`;
    }).join('');
    $('#udt-cards-container').html(`
        <div class="col-12 mb-2">
            <span class="text-muted small">สะสมแล้ว <strong>${totalUniq} ชนิด</strong> รวม <strong>${totalQty} ใบ</strong>
                &nbsp;·&nbsp;
                <span class="badge bg-warning text-dark">UR</span>
                <span class="badge bg-danger">SR</span>
                <span class="badge bg-info text-dark">R</span>
                <span class="badge bg-secondary">C</span>
            </span>
        </div>
        ${cardHtml}
    `);
}

// helper reload cards tab
async function loadUserCardsTab(lineUserId) {
    try {
        const userData = await callApi('/api/admin/user-details', { lineUserId });
        renderAdminUserCards(Array.isArray(userData.cards) ? userData.cards : []);
    } catch(e) { console.error(e); }
}

// ปุ่มปิด admin-score-box (backward compat — hidden แล้ว แต่คง handler ไว้)
$(document).on('click', '#admin-score-box-close', function () {
    $('#admin-score-box').slideUp(150);
});


// ---- START: Notification Functions ----

async function checkUnreadNotifications() {
    try {
        const data = await callApi('/api/notifications/unread-count');

        // data จาก backend = { unreadCount: number }
        const unread = data && typeof data.unreadCount === 'number'
            ? data.unreadCount
            : 0;

        if (unread > 0) {
            $('#notification-badge').show();
        } else {
            $('#notification-badge').hide();
        }
    } catch (e) {
        console.error("Failed to check unread notifications:", e);
        $('#notification-badge').hide();
    }
}


async function openNotificationCenter() {
    const modal = AppState.allModals['notification'];
    modal.show();
    
    const container = $('#notification-list-container');
    container.html('<div class="text-center my-5"><div class="spinner-border text-success"></div></div>');

    try {
        // 1. ดึงข้อมูลแจ้งเตือนทั้งหมดมาแสดง
        const notifications = await callApi('/api/notifications');
        renderNotifications(notifications, container);
        
        // 2. เมื่อเปิดดูแล้ว ให้ส่ง request ไปบอก Server ว่าเราอ่านแล้ว
        await callApi('/api/notifications/mark-read', {}, 'POST');
        
        // 3. ซ่อนจุดแดงบนไอคอนกระดิ่ง
        $('#notification-badge').hide();

    } catch (e) {
        container.html('<p class="text-center text-danger my-4">ไม่สามารถโหลดการแจ้งเตือนได้</p>');
    }
}

function renderNotifications(notifications, container) {
    container.empty();
    if (notifications.length === 0) {
        container.html('<div class="d-flex flex-column justify-content-center align-items-center h-100 text-center"><i class="fas fa-bell-slash fa-3x text-muted mb-3"></i><p class="text-muted">ยังไม่มีการแจ้งเตือน</p></div>');
        return;
    }

    const listGroup = $('<div class="list-group list-group-flush"></div>');
    notifications.forEach(notif => {
        // ใส่ icon ตามประเภทของ notification
        let icon = 'fa-info-circle text-primary';
        
        // --- ของเดิม ---
        if (notif.type === 'like') icon = 'fa-thumbs-up text-primary';
        if (notif.type === 'comment') icon = 'fa-comment-dots text-success';
        if (notif.type === 'approved') icon = 'fa-check-circle text-success';
        if (notif.type === 'rejected') icon = 'fa-times-circle text-danger'; // เพิ่มให้เผื่อไว้
        if (notif.type === 'score') icon = 'fa-star-half-alt text-warning';
        if (notif.type === 'badge') icon = 'fa-award text-warning';

        // --- ✨ ของใหม่ (เพิ่มตรงนี้) ✨ ---
        if (notif.type === 'game_quiz') icon = 'fa-puzzle-piece text-info'; // ไอคอนจิ๊กซอว์สีฟ้า
        if (notif.type === 'game_gacha') icon = 'fa-gift text-danger';      // ไอคอนกล่องของขวัญสีแดง
        // ✨ เพิ่มบรรทัดนี้
        if (notif.type === 'exchange') icon = 'fa-exchange-alt text-warning';

        const isUnreadClass = notif.isRead ? '' : 'list-group-item-light';
        const timeAgo = new Date(notif.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short'});
        
        const itemHtml = `
            <div class="list-group-item ${isUnreadClass}" data-item-id="${notif.relatedItemId}">
                <div class="d-flex align-items-center">
                    <i class="fas ${icon} fa-fw me-3"></i>
                    <div class="flex-grow-1">
                        <p class="mb-0 small">${sanitizeHTML(notif.message)}</p>
                        <small class="text-muted">${timeAgo}</small>
                    </div>
                </div>
            </div>`;
        listGroup.append(itemHtml);
    });
    container.append(listGroup);
}
// ---- END: Notification Functions ----

// ===============================================================
//  UTILITY FUNCTIONS
// ===============================================================
function showLoading(title) { Swal.fire({ title: title, text: 'กรุณารอสักครู่', allowOutsideClick: false, didOpen: () => Swal.showLoading() }); }
function showSuccess(title) { Swal.fire({icon: 'success', title: 'สำเร็จ!', text: title, timer: 1500, showConfirmButton: false}); }
function showError(title) { Swal.fire('เกิดข้อผิดพลาด', title, 'error'); }
function showWarning(title) { Swal.fire('คำเตือน', title, 'warning'); }
function sanitizeHTML(str) {
    if (!str) return '';
    const temp = document.createElement('div');
    temp.textContent = str;
    return temp.innerHTML;
}

// Collapsible submission description (user-facing feed)
function buildCollapsibleDescription(id, text) {
    if (!text) return '';
    const safe = sanitizeHTML(text);
    const LIMIT = 180;
    if (safe.length <= LIMIT) {
        return `<p class="card-text submission-description mb-3 preserve-whitespace">${safe}</p>`;
    }
    const preview = safe.slice(0, LIMIT).trimEnd() + '…';
    return `
        <p class="card-text submission-description mb-1 preserve-whitespace" id="sub-desc-${id}">
            <span class="sub-desc-preview">${preview}</span>
            <span class="sub-desc-full d-none">${safe}</span>
        </p>
        <a href="#" class="sub-expand-btn small text-primary mb-3 d-block" data-id="${id}">
            <i class="fas fa-chevron-down me-1"></i>ดูเพิ่มเติม
        </a>`;
}

// Format report/submission description into a readable structured list
function formatReportDescription(text) {
    if (!text) return '<span class="text-muted">ไม่มีคำอธิบาย</span>';
    const safe = sanitizeHTML(text);
    // Split by newlines or numbered patterns like "1.", "2. "
    const lines = safe.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) {
        // Single block — split by inline numbered items "1.", "2." etc.
        const parts = safe.split(/(?=\d{1,2}[\.\)]\s)/);
        if (parts.length > 2) {
            return '<ol class="mb-0 ps-3">' +
                parts.map(p => p.trim()).filter(Boolean)
                     .map(p => `<li class="mb-1">${p.replace(/^\d{1,2}[\.\)]\s*/, '')}</li>`)
                     .join('') +
                '</ol>';
        }
        return `<p class="mb-0">${safe}</p>`;
    }
    // Multi-line: render each line, detect numbered items
    const isNumbered = lines.filter(l => /^\d{1,2}[\.\)]\s/.test(l)).length > lines.length / 2;
    if (isNumbered) {
        return '<ol class="mb-0 ps-3">' +
            lines.map(l => `<li class="mb-1">${l.replace(/^\d{1,2}[\.\)]\s*/, '')}</li>`).join('') +
            '</ol>';
    }
    return lines.map(l => `<p class="mb-1">${l}</p>`).join('');
}

// --- GAME LOGIC ---

async function loadGamePage() {
    $('#game-loading').show();
    $('#game-content').hide();
    $('#game-played').hide();
    
    try {
        const result = await callApi('/api/game/daily-question', { lineUserId: AppState.lineProfile.userId });
        
        $('#game-loading').hide();

        if (result.played) {
            $('#game-played').fadeIn();
        } else {
            const q = result.question;
            $('#game-content').data('qid', q.questionId);
            $('#question-text').text(q.text);
            // แสดงเฉพาะ options ที่มีข้อความ ซ่อน options ที่ว่าง
            ['a','b','c','d','e','f','g','h'].forEach(function(letter) {
                const text = q.options[letter.toUpperCase()];
                const span = $('#option-' + letter);
                const col  = span.closest('.col-6');
                if (text) {
                    span.text(text);
                    col.show();
                } else {
                    col.hide();
                }
            });
            
            if(q.image) {
                $('#question-image').attr('src', q.image).show();
                $('#no-image-icon').hide();
            } else {
                $('#question-image').hide();
                $('#no-image-icon').show(); // โชว์ไอคอนแทนที่โล่งๆ
            }
            
            // Reset ปุ่ม
            $('.answer-btn').removeClass('correct wrong').prop('disabled', false);
            $('#game-content').fadeIn();
        }
    } catch (e) {
        $('#game-loading').html('<p class="text-danger">โหลดข้อมูลไม่สำเร็จ</p>');
    }
}

// --- แก้ไข Event Listener ตอบคำถาม (รองรับระบบกู้คืน Streak) ---
$(document).on('click', '.answer-btn', async function() {

    // 1. สั่นเบาๆ เมื่อนิ้วแตะปุ่ม
    triggerHaptic('light');

    const btn = $(this);
    const choice = btn.data('choice');
    const qid = $('#game-content').data('qid');

    $('.answer-btn').prop('disabled', true); // ล็อกปุ่มกันกดซ้ำ

    try {
        // ⭐ เปลี่ยน Endpoint เป็น v2 เพื่อรับค่า recoverableStreak
        const res = await callApi('/api/game/submit-answer-v2', {
            lineUserId: AppState.lineProfile.userId,
            questionId: qid,
            selectedOption: choice
        }, 'POST');

        // 2. อัปเดตเหรียญและคะแนนทันที
        syncCoins(res.newCoinBalance);
        if (AppState.currentUser) {
            AppState.currentUser.totalScore = res.newTotalScore;
            $('#user-score, #profile-page-score').text(res.newTotalScore);
        }

        // 3. แสดงผล ถูก/ผิด
        if (res.isCorrect) {
            triggerHaptic('medium');
            btn.addClass('correct');
            Swal.fire({
                icon: 'success',
                title: 'ถูกต้อง! เก่งมาก',
                html: `คุณได้รับ <b class="text-warning">${res.earnedCoins} เหรียญ</b> 💰 และ <b class="text-success">+${res.earnedScore} คะแนน</b> ⭐`,
                confirmButtonText: 'เยี่ยมเลย',
                confirmButtonColor: '#06C755',
                timer: 2500
            });
        } else {
            triggerHaptic('heavy');
            btn.addClass('wrong');
            Swal.fire({
                icon: 'error',
                title: 'ยังไม่ถูกนะ...',
                html: `คำตอบยังไม่ถูกต้อง<br>รับรางวัลปลอบใจไป <b class="text-warning">${res.earnedCoins} เหรียญ</b> 💰 และ <b class="text-success">+${res.earnedScore} คะแนน</b>`,
                confirmButtonText: 'ไปต่อ',
                confirmButtonColor: '#6c757d',
                timer: 2500
            });
        }

        // ⭐ 4. Logic ใหม่: ตรวจสอบการกู้คืน Streak
        // รอ 2.2 วินาที (ให้คนดูผลตอบถูกผิดก่อน) แล้วค่อยเช็ค
        setTimeout(() => {
            if (res.recoverableStreak > 0) {
                // 🔥 พบสถิติที่กู้คืนได้! แสดง Popup ชวนกู้คืน
                Swal.fire({
                    title: '🔥 ไฟดับไปแล้ว!',
                    html: `คุณพลาดการเล่นทำให้สถิติ <b>${res.recoverableStreak} วัน</b> หายไป<br>ต้องการใช้ <b>200 เหรียญ</b> เพื่อกู้คืนไหม?`,
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonColor: '#06C755', // เขียว = ยืนยัน
                    cancelButtonColor: '#6c757d',  // เทา = ยกเลิก
                    confirmButtonText: 'กู้คืนเดี๋ยวนี้! (200💰)',
                    cancelButtonText: 'ไม่เป็นไร เริ่มใหม่'
                }).then(async (result) => {
                    if (result.isConfirmed) {
                        // เรียก API กู้คืน
                        try {
                            const restoreRes = await callApi('/api/game/restore-streak', { lineUserId: AppState.lineProfile.userId }, 'POST');
                            
                            // อัปเดตเหรียญหลังจ่ายค่ากู้คืน
                            syncCoins(restoreRes.newCoinBalance);

                            Swal.fire('สำเร็จ!', restoreRes.message, 'success').then(() => {
                                closeQuizAndReload();
                            });
                        } catch (err) {
                            Swal.fire('เสียใจด้วย', err.message, 'error').then(() => {
                                closeQuizAndReload();
                            });
                        }
                    } else {
                        // ถ้าไม่กู้คืน ก็ปิดเกมปกติ
                        closeQuizAndReload();
                    }
                });
            } else {
                // ถ้าไม่มีอะไรให้กู้คืน ก็ปิดเกมปกติ
                closeQuizAndReload();
            }
        }, 2200);

    } catch (e) {
        Swal.fire('แจ้งเตือน', e.message, 'warning');
        $('.answer-btn').prop('disabled', false); // ปลดล็อกปุ่มถ้า Error
    }
});

// ฟังก์ชันช่วยปิด Modal และโหลดข้อมูลใหม่
function closeQuizAndReload() {
    // ปิด Modal Quiz
    if (AppState.allModals['quiz']) {
        AppState.allModals['quiz'].hide();
    } else {
        const modalEl = document.getElementById('quiz-modal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if(modal) modal.hide();
    }

    // ⭐ สั่งโหลดข้อมูลหน้าเกมใหม่ทันที
    loadGameDashboard(); 
}

// ==========================================
// --- ADMIN: QUESTION MANAGEMENT (FIXED V.2) ---
// ==========================================

// 1. ฟังก์ชันเปิด Modal หลัก (เรียกใช้ loadAdminQuestions)
function handleManageQuestions() {
    if (!AppState.allModals['admin-questions']) {
        AppState.allModals['admin-questions'] = new bootstrap.Modal(document.getElementById('admin-questions-modal'));
    }
    AppState.allModals['admin-questions'].show();
    $('#question-search-input').val('');
    loadAdminQuestions();
}

// Filter + Render คำถามจากข้อมูลที่ cache ไว้
function renderFilteredQuestions(questions, query) {
    const list = $('#questions-list-admin');
    list.empty();
    const filtered = query
        ? questions.filter(q => q.questionText.toLowerCase().includes(query.toLowerCase()))
        : questions;
    if (filtered.length === 0) {
        list.html('<div class="col-12 text-center text-muted mt-5">ไม่พบคำถามที่ค้นหา</div>');
        return;
    }
    filtered.forEach(q => renderQuestionCard(list, q));
}

// 2. ฟังก์ชันดึงรายการคำถามมาแสดง (แยกออกมาเพื่อ reuse ตอนบันทึกเสร็จ)
async function loadAdminQuestions() {
    const list = $('#questions-list-admin');
    list.html('<div class="col-12 text-center my-5"><div class="spinner-border text-success"></div></div>');

    try {
        const questions = await callApi('/api/admin/questions');
        AppState._cachedQuestions = questions;
        list.empty();

        if (questions.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีคำถามในระบบ</div>');
            return;
        }

        const query = $('#question-search-input').val() || '';
        renderFilteredQuestions(questions, query);

        // bind search
        $('#question-search-input').off('input.qsearch').on('input.qsearch', function() {
            renderFilteredQuestions(AppState._cachedQuestions || [], $(this).val());
        });

    } catch (e) {
        list.html(`<div class="col-12 text-center text-danger">เกิดข้อผิดพลาด: ${e.message}</div>`);
    }
}

function renderQuestionCard(list, q) {
    const isActive = q.isActive;
    const statusBadge = isActive
        ? '<span class="badge bg-success">ใช้งาน</span>'
        : '<span class="badge bg-secondary">ปิด</span>';
    const statusBtnClass = isActive ? 'btn-outline-secondary' : 'btn-outline-success';
    const statusBtnText = isActive ? 'ปิด' : 'เปิด';
    const qData = encodeURIComponent(JSON.stringify(q));
    const imgHtml = q.imageUrl
        ? `<img src="${getFullImageUrl(q.imageUrl)}" class="rounded mb-2" style="height: 80px; object-fit: cover;">`
        : '';
    const html = `
    <div class="col-12 col-md-6 col-lg-4">
        <div class="card h-100 shadow-sm border-0">
            <div class="card-body position-relative">
                <div class="d-flex justify-content-between mb-2">
                    ${statusBadge}
                    <small class="text-muted"><i class="fas fa-star text-warning"></i> ${q.scoreReward} คะแนน</small>
                </div>
                <div class="d-flex gap-3">
                    ${imgHtml}
                    <div style="min-width: 0;">
                        <h6 class="fw-bold mb-1 text-dark text-truncate">${sanitizeHTML(q.questionText)}</h6>
                        <p class="mb-0 small text-muted text-truncate">
                            <span class="${q.correctOption === 'A' ? 'text-success fw-bold' : ''}">A: ${sanitizeHTML(q.optionA)}</span><br>
                            <span class="${q.correctOption === 'B' ? 'text-success fw-bold' : ''}">B: ${sanitizeHTML(q.optionB)}</span>
                        </p>
                    </div>
                </div>
                <div class="mt-3 d-flex gap-2 justify-content-end">
                    <button class="btn btn-sm ${statusBtnClass} btn-toggle-q" data-id="${q.questionId}">${statusBtnText}</button>
                    <button class="btn btn-sm btn-primary btn-edit-question" data-question="${qData}"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-danger btn-delete-q" data-id="${q.questionId}"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        </div>
    </div>`;
    list.append(html);
}

// 3. ฟังก์ชันกดปุ่ม "เพิ่มคำถามใหม่"
function handleAddQuestion() {
    $('#question-form-title').text('เพิ่มคำถามใหม่');
    $('#question-form')[0].reset();
    $('#q-id').val('');
    
    // Reset รูปภาพ
    $('#q-image-final-url').val('');
    $('#q-image-url-text').val('');
    $('#q-image-preview').hide().attr('src', '');
    $('#q-no-preview-text').show();
    
    // Reset กลับไปโหมด Upload
    $('#q-sourceUpload').prop('checked', true).trigger('change');
    
    if (!AppState.allModals['question-form']) {
        AppState.allModals['question-form'] = new bootstrap.Modal(document.getElementById('question-form-modal'));
    }
    AppState.allModals['question-form'].show();
}

// 4. ฟังก์ชันกดปุ่ม "แก้ไข" (ในรายการ)
function handleEditQuestion() {
    // ดึงข้อมูลจากปุ่ม (แก้ปัญหา JSON Parse Error)
    const rawData = $(this).attr('data-question');
    if (!rawData) {
        return Swal.fire('Error', 'ไม่พบข้อมูลคำถาม', 'error');
    }

    try {
        const data = JSON.parse(decodeURIComponent(rawData));

        $('#question-form-title').text('แก้ไขคำถาม');
        $('#q-id').val(data.questionId);
        $('#q-text').val(data.questionText);
        
        // ใส่ข้อมูลตัวเลือก A-H
        $('#q-opt-a').val(data.optionA); $('#q-opt-b').val(data.optionB);
        $('#q-opt-c').val(data.optionC || ''); $('#q-opt-d').val(data.optionD || '');
        $('#q-opt-e').val(data.optionE || ''); $('#q-opt-f').val(data.optionF || '');
        $('#q-opt-g').val(data.optionG || ''); $('#q-opt-h').val(data.optionH || '');
        
        // เลือกเฉลย
        $(`input[name="correctOption"][value="${data.correctOption}"]`).prop('checked', true);
        $('#q-score').val(data.scoreReward || 10);

        // --- จัดการรูปภาพ (URL / Upload) ---
        const currentImg = data.imageUrl || '';
        $('#q-image-final-url').val(currentImg);
        $('#q-image-url-text').val(currentImg);

        if (currentImg) {
            $('#q-image-preview').attr('src', getFullImageUrl(currentImg)).show();
            $('#q-no-preview-text').hide();
        } else {
            $('#q-image-preview').hide();
            $('#q-no-preview-text').show();
        }

        // รีเซ็ตกลับไปโหมด Upload (แต่ถ้ามีลิงก์อยู่ อาจจะอยากให้โชว์ URL ก็ได้ แล้วแต่ชอบ)
        $('#q-sourceUpload').prop('checked', true).trigger('change');
        $('#q-image-input').val('');

        // เปิด Modal
        if (!AppState.allModals['question-form']) {
            AppState.allModals['question-form'] = new bootstrap.Modal(document.getElementById('question-form-modal'));
        }
        AppState.allModals['question-form'].show();

    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'ข้อมูลคำถามผิดพลาด', 'error');
    }
}

// 5. ฟังก์ชันบันทึก (Save)
async function handleSaveQuestion(e) {
    e.preventDefault();
    const btn = $(this).find('button[type="submit"]');
    btn.prop('disabled', true).text('กำลังบันทึก...');

    try {
        // ... (ส่วนจัดการรูปภาพเหมือนเดิม) ...
        const mode = $('input[name="q-imgSource"]:checked').val();
        let finalImageUrl = $('#q-image-final-url').val(); 

        if (mode === 'upload') {
            const fileInput = $('#q-image-input')[0];
            if (fileInput.files.length > 0) {
                finalImageUrl = await uploadImage(fileInput.files[0]);
            }
        } else {
            const urlInput = $('#q-image-url-text').val().trim();
            if (urlInput) finalImageUrl = urlInput;
        }
        // ...

        const payload = {
            questionId: $('#q-id').val(), // ⭐ เช็คตรงนี้
            questionText: $('#q-text').val(),
            optionA: $('#q-opt-a').val(), optionB: $('#q-opt-b').val(),
            optionC: $('#q-opt-c').val(), optionD: $('#q-opt-d').val(),
            optionE: $('#q-opt-e').val(), optionF: $('#q-opt-f').val(),
            optionG: $('#q-opt-g').val(), optionH: $('#q-opt-h').val(),
            correctOption: $('input[name="correctOption"]:checked').val(),
            scoreReward: $('#q-score').val(),
            imageUrl: finalImageUrl
        };

        // ⭐ ถ้ามี ID ให้ใช้ PUT (แก้ไข) ถ้าไม่มีใช้ POST (เพิ่มใหม่)
        const method = payload.questionId ? 'PUT' : 'POST';
        await callApi('/api/admin/questions', payload, method);
        
        AppState.allModals['question-form'].hide();
        showSuccess('บันทึกข้อมูลเรียบร้อย');
        loadAdminQuestions(); // รีเฟรชตารางทันที

    } catch (e) {
        showError(e.message);
    } finally {
        btn.prop('disabled', false).text('บันทึกข้อมูล');
    }
}

// 6. ฟังก์ชันลบ
async function handleDeleteQuestion() {
    const id = $(this).data('id');
    const result = await Swal.fire({
        title: 'ยืนยันการลบ?',
        text: "ข้อมูลประวัติการเล่นของข้อนี้จะถูกลบไปด้วย",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'ลบเลย'
    });

    if (result.isConfirmed) {
        try {
            await callApi(`/api/admin/questions/${id}`, {}, 'DELETE');
            showSuccess('ลบเรียบร้อย');
            loadAdminQuestions(); // Refresh UI
        } catch (e) {
            showError(e.message);
        }
    }
}

// 7. ฟังก์ชันเปิด/ปิดใช้งาน
async function handleToggleQuestion() {
    const btn = $(this);
    btn.prop('disabled', true);
    try {
        await callApi('/api/admin/questions/toggle', { questionId: btn.data('id') }, 'POST');
        loadAdminQuestions(); // Refresh UI
    } catch (e) {
        showError('ไม่สามารถเปลี่ยนสถานะได้');
        btn.prop('disabled', false);
    }
}

// ===============================================================
//  GAME DASHBOARD & GACHA LOGIC (NEW V.2)
// ===============================================================

// เก็บอันนี้ไว้ (อันเดียวพอ)
async function loadGameDashboard() {
    console.log("Loading Game Dashboard...");

    const user = AppState.currentUser;
    if (!user) return; // guard: ยังไม่ login

    // 1. อัปเดตเหรียญ + Streak
    syncCoins(user.coinBalance || 0);
    $('#streak-display').text((user.currentStreak || 0) + " วัน");

    // 2. ดึงข้อมูลการ์ด
    try {
        const cards = await callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId });
        AppState._lastCards = cards; // cache for profile completion stat

        // ⭐ ต้องมีท่อนคำนวณหลอดตรงนี้ ⭐
        const totalCards = cards.length;
        const ownedCount = cards.filter(c => c.isOwned).length;
        
        if (typeof updateCollectionProgressBar === 'function') {
            updateCollectionProgressBar(ownedCount, totalCards);
        }
        // --------------------------------

        const recentCards = cards.filter(c => c.isOwned).slice(0, 5);
        const list = $('#mini-collection-list');
        list.empty();
        
        if(recentCards.length === 0) {
            list.html('<div class="text-muted small p-2">ยังไม่มีการ์ด</div>');
        } else {
            recentCards.forEach(c => {
                let borderColor = '#dee2e6';
                if (c.rarity === 'UR') borderColor = '#ffc107';
                
                list.append(`
                    <img src="${getFullImageUrl(c.imageUrl)}" class="rounded border bg-white" 
                         style="width: 50px; height: 50px; object-fit: cover; border-color: ${borderColor} !important;" 
                         data-bs-toggle="tooltip" title="${c.cardName}">
                `);
            });
            const tooltips = list.find('[data-bs-toggle="tooltip"]');
            [...tooltips].map(el => new bootstrap.Tooltip(el));
        }
    } catch (e) { console.error(e); }

    // Now Playing bar
    $('#now-playing-pic').attr('src', user.pictureUrl || 'https://placehold.co/36x36');
    $('#now-playing-name').text(user.fullName || 'ผู้เล่น');
    $('#now-playing-bar').removeClass('d-none');

    // Card completion % for profile
    try {
        const cards = AppState._lastCards;
        if (cards) {
            const owned = cards.filter(c => c.isOwned).length;
            const pct = cards.length > 0 ? Math.round((owned / cards.length) * 100) : 0;
            $('#profile-page-completion').text(pct + '%');
        }
    } catch(e) {}

    // ตรวจสอบสถานะ Daily Quiz + เตือน Streak
    try {
        const quizStatus = await callApi('/api/game/daily-question', { lineUserId: AppState.lineProfile.userId });

        // U-2: อัปเดต badge บน Daily Quiz bento card
        const quizBadge = $('#daily-quiz-status-badge');
        if (quizStatus.played) {
            quizBadge.removeClass('bg-success-subtle text-success')
                     .addClass('bg-secondary-subtle text-secondary')
                     .html('<i class="fas fa-check me-1"></i>เล่นแล้ววันนี้');
            $('#daily-quiz-btn-card').css('opacity', '0.75');
        } else {
            quizBadge.removeClass('bg-secondary-subtle text-secondary')
                     .addClass('bg-success-subtle text-success')
                     .text('Daily Mission');
            $('#daily-quiz-btn-card').css('opacity', '1');
        }

        // U-5: เตือน Streak ถ้ายังไม่เล่นวันนี้และมี streak อยู่
        const streak = user.currentStreak || 0;
        if (!quizStatus.played && streak > 0 && !AppState._streakWarningShown) {
            AppState._streakWarningShown = true;
            setTimeout(() => {
                Swal.fire({
                    icon: 'warning',
                    title: '⚠️ Streak กำลังจะหาย!',
                    html: `สาย <b class="text-danger">${streak} วัน</b> ของคุณจะหายถ้าไม่เล่น KYT วันนี้!`,
                    confirmButtonText: '<i class="fas fa-helmet-safety me-1"></i> ไปเล่น Quiz เลย!',
                    showCancelButton: true,
                    cancelButtonText: 'ทีหลัง',
                    confirmButtonColor: '#06C755',
                    cancelButtonColor: '#adb5bd',
                }).then(r => { if (r.isConfirmed) startDailyQuiz(); });
            }, 1000);
        }
    } catch(e) { console.error('Quiz status check failed:', e); }
}

// 2. ฟังก์ชันเริ่ม Quiz (ผูกกับปุ่ม "เริ่มเล่นเลย")
// ในไฟล์ app.js ค้นหา function startDailyQuiz() และแก้เป็นแบบนี้ครับ
function startDailyQuiz() {
    // เรียกใช้จาก AppState แทนการ new bootstrap.Modal ใหม่
    if (AppState.allModals['quiz']) {
        AppState.allModals['quiz'].show();
    } else {
        // กันเหนียว เผื่อยังไม่ได้ init
        const quizModal = new bootstrap.Modal(document.getElementById('quiz-modal'));
        AppState.allModals['quiz'] = quizModal;
        quizModal.show();
    }
    
    // โหลดคำถาม
    loadGamePage(); 
}

// 3. ฟังก์ชันหมุนกาชา (Ultra Premium: Card Reveal Style)
async function pullGacha() {
    const currentCoins = parseInt($('#coin-display').text().replace(/,/g, '')) || 0;
    if (currentCoins < 100) {
        triggerHaptic('heavy');
        return Swal.fire({
            icon: 'warning',
            title: 'เหรียญไม่พอ',
            text: 'ต้องการ 100 เหรียญ',
            confirmButtonText: 'โอเค'
        });
    }

    // ยืนยันก่อนสุ่ม
    const confirmResult = await Swal.fire({
        icon: 'question',
        title: 'ยืนยันการสุ่มการ์ด',
        html: `ใช้ <b class="text-warning fs-5">100 เหรียญ</b> เพื่อสุ่มการ์ด Safety 1 ใบ`,
        confirmButtonText: '<i class="fas fa-wand-magic-sparkles me-1"></i> สุ่มเลย!',
        cancelButtonText: 'ยกเลิก',
        showCancelButton: true,
        confirmButtonColor: '#06C755',
        cancelButtonColor: '#adb5bd',
    });
    if (!confirmResult.isConfirmed) return;

    triggerHaptic('medium');

    // 1. สร้าง Overlay มารอไว้ก่อน (ยังไม่ใส่ข้อมูล)
    const overlayId = 'gacha-' + Date.now();
    const overlayHtml = `
        <div id="${overlayId}" class="gacha-overlay animate__animated animate__fadeIn">
            <div class="gacha-burst"></div>

            <h2 class="text-white fw-bold mb-4 animate__animated animate__pulse animate__infinite">
                กำลังสุ่ม...
            </h2>

            <div class="gacha-card-container">
                <div class="gacha-card" id="card-${overlayId}">
                    <!-- ตอนนี้ใช้เฉพาะด้านหน้าเท่านั้น -->
                    <div class="gacha-face gacha-front">
                        <img id="img-${overlayId}" src="" class="img-fluid mb-2" style="max-height: 150px;">
                        <div class="badge bg-warning text-dark mb-1" id="rarity-${overlayId}">.</div>
                        <h5 class="fw-bold text-dark text-center mb-0" id="name-${overlayId}">.</h5>
                    </div>
                </div>
            </div>

            <div class="gacha-sparkles"></div>

            <button class="btn-claim" id="btn-${overlayId}">เก็บใส่สมุด</button>
        </div>
    `;
    $('body').append(overlayHtml);

    try {
        // 2. ยิง API ขอข้อมูล
        const res = await callApi('/api/game/gacha-pull', { lineUserId: AppState.lineProfile.userId }, 'POST');

        // อัปเดตเหรียญ
        syncCoins(res.remainingCoins);

        // 3. ใส่ข้อมูลลงในการ์ด
        $(`#img-${overlayId}`).attr('src', getFullImageUrl(res.badge.imageUrl));
        $(`#name-${overlayId}`).text(res.badge.badgeName);
        $(`#rarity-${overlayId}`).text(res.badge.rarity || 'Common');

        // ⭐⭐⭐ เพิ่ม: สร้างกล่องโชว์เหรียญโบนัส (ซ่อนไว้ก่อน) ⭐⭐⭐
        const bonusHtml = `
            <div id="bonus-${overlayId}" class="position-absolute start-50 translate-middle-x" 
                 style="bottom: 80px; opacity: 0; transition: all 0.5s ease; z-index: 20;">
                <div class="badge bg-warning text-dark shadow-lg fs-5 rounded-pill px-3 border border-white">
                    <i class="fas fa-coins text-warning-emphasis"></i> +${res.bonusCoins}
                </div>
            </div>
        `;
        $(`#${overlayId}`).append(bonusHtml);

        $(`#${overlayId} h2`).text("แตะเพื่อเปิด!");

        // 4. รอให้ user แตะการ์ดเพื่อเปิด
        $(`#${overlayId}`).one('click', function () {
            triggerHaptic('heavy');

            // เอฟเฟกต์การ์ดเด้ง + glow
            $(`#card-${overlayId}`).addClass('flipped'); // ตอนนี้ใช้เป็น state "เปิดการ์ด"

            // เอฟเฟกต์สั่นหน้าจอเล็กน้อย
            document.body.classList.add('shake-screen');
            setTimeout(() => {
                document.body.classList.remove('shake-screen');
            }, 400);

            // เปิดประกายไฟรอบการ์ด
            $(`#${overlayId} .gacha-sparkles`).addClass('active');

            // เปลี่ยนหัวข้อ
            $(`#${overlayId} h2`).text("ยินดีด้วย!").addClass('text-warning');

            // ⭐⭐⭐ เพิ่ม: สั่งให้กล่องเหรียญลอยขึ้นมา ⭐⭐⭐
            setTimeout(() => {
                $(`#bonus-${overlayId}`).css({
                    'opacity': '1',
                    'bottom': '120px', // ลอยขึ้น
                    'transform': 'translate(-50%, 0) scale(1.2)' 
                });
            }, 600); // ดีเลย์นิดนึงหลังการ์ดเปิด

            // โชว์ปุ่มเก็บใส่สมุด
            $(`#btn-${overlayId}`).addClass('show');

            // เอฟเฟกต์พลุ (confetti เบาๆ)
            Swal.fire({
                title: '',
                width: 0,
                padding: 0,
                background: 'transparent',
                backdrop: `rgba(0,0,0,0) url("https://assets2.lottiefiles.com/packages/lf20_u4yrau.json") center center no-repeat`,
                timer: 2000,
                showConfirmButton: false
            });
        });

        // 5. ปุ่มปิด / เก็บใส่สมุด
        $(`#btn-${overlayId}`).on('click', function (e) {
            e.stopPropagation(); // กันกระทบ overlay-click
            $(`#${overlayId}`).removeClass('animate__fadeIn').addClass('animate__fadeOut');
            setTimeout(() => $(`#${overlayId}`).remove(), 500);
            loadGameDashboard();
        });

    } catch (e) {
        $(`#${overlayId}`).remove();
        Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
    }
}

// --- CARD ALBUM LOGIC ---

function renderAlbumGrid(cards, query) {
    const container = $('#album-grid');
    container.empty();
    const filtered = query
        ? cards.filter(c => c.cardName.toLowerCase().includes(query.toLowerCase()))
        : cards;

    if (filtered.length === 0) {
        container.html('<div class="col-12 text-center text-muted py-5">ไม่พบการ์ดที่ค้นหา</div>');
    } else {
        filtered.forEach(c => {
            let borderColor = '#dee2e6';
            let bgBadge = 'bg-secondary';
            if (c.rarity === 'R') { borderColor = '#0dcaf0'; bgBadge = 'bg-info'; }
            if (c.rarity === 'SR') { borderColor = '#d63384'; bgBadge = 'bg-danger'; }
            if (c.rarity === 'UR') { borderColor = '#ffc107'; bgBadge = 'bg-warning text-dark'; }
            const imgFilter = c.isOwned ? '' : 'filter: grayscale(100%); opacity: 0.5;';
            const countBadge = c.count > 1 ? `<span class="position-absolute top-0 end-0 translate-middle badge rounded-pill bg-danger border border-white">+${c.count}</span>` : '';
            container.append(`
                <div class="col-4 col-sm-3 mb-2">
                    <div class="card h-100 border-0 shadow-sm position-relative" style="overflow: visible;">
                        ${countBadge}
                        <div class="card-body p-2 text-center d-flex flex-column align-items-center">
                            <div class="rounded-3 mb-2 d-flex align-items-center justify-content-center"
                                 style="width:100%;aspect-ratio:1/1;border:2px solid ${borderColor};background:#fff;overflow:hidden;">
                                <img src="${getFullImageUrl(c.imageUrl)}" class="img-fluid" style="${imgFilter}" onerror="this.src='https://placehold.co/100?text=?'">
                            </div>
                            <span class="badge ${bgBadge} mb-1" style="font-size:0.6rem;">${c.rarity}</span>
                            <small class="d-block text-truncate w-100 fw-bold" style="font-size:0.7rem;">${c.cardName}</small>
                        </div>
                    </div>
                </div>
            `);
        });
    }

    // Update progress (always based on full list)
    const ownedCount = cards.filter(c => c.isOwned).length;
    const progress = cards.length > 0 ? Math.round((ownedCount / cards.length) * 100) : 0;
    $('#album-progress-text').text(`${ownedCount}/${cards.length}`);
    $('#album-progress-bar').css('width', `${progress}%`);
}

async function openCardAlbum() {
    if (document.activeElement) document.activeElement.blur();
    const modal = new bootstrap.Modal(document.getElementById('card-album-modal'));
    modal.show();

    const container = $('#album-grid');
    container.html('<div class="col-12 text-center py-5"><div class="spinner-border text-primary"></div></div>');
    $('#album-search-input').val('');

    try {
        const cards = await callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId });

        renderAlbumGrid(cards, '');

        // Search binding
        $('#album-search-input').off('input').on('input', function () {
            renderAlbumGrid(cards, $(this).val().trim());
        });

    } catch (e) {
        console.error(e);
        container.html('<p class="text-danger text-center">โหลดข้อมูลไม่สำเร็จ</p>');
    }
}

// --- ADMIN: CARD MANAGEMENT ---

function renderFilteredCards(cards, query) {
    const list = $('#cards-list-admin');
    list.empty();
    const filtered = query
        ? cards.filter(c => c.cardName.toLowerCase().includes(query.toLowerCase()))
        : cards;
    if (filtered.length === 0) {
        list.html('<div class="col-12 text-center text-muted mt-5">ไม่พบการ์ดที่ค้นหา</div>');
        return;
    }
    filtered.forEach(c => {
        let badgeClass = 'bg-secondary';
        if (c.rarity === 'R') badgeClass = 'bg-info text-dark';
        if (c.rarity === 'SR') badgeClass = 'bg-danger';
        if (c.rarity === 'UR') badgeClass = 'bg-warning text-dark';
        const cardData = encodeURIComponent(JSON.stringify(c));
        const imgHtml = c.imageUrl
            ? `<img src="${getFullImageUrl(c.imageUrl)}" class="card-img-top" style="height: 140px; object-fit: contain; padding: 10px; background: #f8f9fa;">`
            : '<div class="bg-light" style="height:140px;"></div>';
        const html = `
        <div class="col-6 col-md-4 col-lg-3">
            <div class="card h-100 shadow-sm border-0">
                <div class="position-relative">
                    ${imgHtml}
                    <span class="position-absolute top-0 end-0 badge ${badgeClass} m-2 shadow-sm">${c.rarity}</span>
                </div>
                <div class="card-body p-2 text-center">
                    <h6 class="fw-bold text-dark mb-1 text-truncate">${sanitizeHTML(c.cardName)}</h6>
                    <small class="text-muted d-block text-truncate mb-2" style="font-size: 0.7rem;">${sanitizeHTML(c.description || '-')}</small>
                    <div class="d-flex justify-content-center gap-2">
                        <button class="btn btn-sm btn-outline-primary btn-edit-card" data-card='${cardData}'><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-outline-danger btn-delete-card" data-id="${c.cardId}"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </div>`;
        list.append(html);
    });
}

async function handleManageCards() {
    const list = $('#cards-list-admin');
    list.html('<div class="col-12 text-center my-5"><div class="spinner-border text-success"></div></div>');
    const modal = new bootstrap.Modal(document.getElementById('admin-cards-modal'));
    modal.show();
    $('#card-search-input').val('');

    try {
        const cards = await callApi('/api/admin/cards');
        AppState._cachedCards = cards;
        if (cards.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีการ์ดในระบบ</div>');
            return;
        }
        renderFilteredCards(cards, '');
        $('#card-search-input').off('input.csearch').on('input.csearch', function() {
            renderFilteredCards(AppState._cachedCards || [], $(this).val());
        });
    } catch (e) {
        list.html(`<div class="col-12 text-center text-danger">เกิดข้อผิดพลาด: ${e.message}</div>`);
    }
}

// ==========================================
//  ADMIN: CARD MANAGEMENT LOGIC (UPDATED)
// ==========================================

// 1. ฟังก์ชันสลับโหมด Upload / URL (ใส่ไว้ที่ Global Scope หรือใน bindAdminEventListeners)
$(document).ready(function() {
    // เมื่อกดเปลี่ยน Radio Button
    $(document).on('change', 'input[name="imgSource"]', function() {
        const mode = $(this).val();
        if(mode === 'upload') {
            $('#input-group-upload').show();
            $('#input-group-url').hide();
        } else {
            $('#input-group-upload').hide();
            $('#input-group-url').show();
        }
    });

    // Preview เมื่อใส่ URL ในช่อง Text
    $('#card-image-url-text').on('input', function() {
        const url = $(this).val().trim();
        if(url) {
            $('#card-image-preview').attr('src', url).show();
            $('#no-preview-text').hide();
        } else {
            $('#card-image-preview').hide();
            $('#no-preview-text').show();
        }
    });
});

// 2. ฟังก์ชันเตรียมฟอร์มเพิ่มการ์ดใหม่
function handleAddCard() {
    $('#card-form-title').text('เพิ่มการ์ดใหม่');
    $('#card-form')[0].reset();
    $('#card-id').val('');
    $('#card-image-final-url').val('');
    
    // รีเซ็ต Preview
    $('#card-image-preview').hide().attr('src', '');
    $('#no-preview-text').show();
    
    // รีเซ็ตกลับไปโหมด Upload
    $('#sourceUpload').prop('checked', true).trigger('change');
    
    new bootstrap.Modal(document.getElementById('card-form-modal')).show();
}

// 3. ฟังก์ชันเตรียมฟอร์มแก้ไขการ์ด
function handleEditCard() {
    const data = JSON.parse(decodeURIComponent($(this).data('card')));
    
    $('#card-form-title').text('แก้ไขการ์ด');
    $('#card-id').val(data.cardId);
    $('#card-name').val(data.cardName);
    $('#card-desc').val(data.description);
    $('#card-rarity').val(data.rarity);
    
    // เก็บค่ารูปเดิมไว้
    const currentImg = data.imageUrl || '';
    $('#card-image-final-url').val(currentImg);
    $('#card-image-url-text').val(currentImg); // ใส่ในช่อง URL เผื่อแอดมินอยากแก้ลิงก์

    // แสดง Preview
    if (currentImg) {
        $('#card-image-preview').attr('src', getFullImageUrl(currentImg)).show();
        $('#no-preview-text').hide();
    } else {
        $('#card-image-preview').hide();
        $('#no-preview-text').show();
    }

    // Default เป็น Upload mode แต่ถ้าอยากให้ฉลาดกว่านี้ อาจจะเช็คว่าถ้าเป็น http ให้เด้งไป URL mode ก็ได้
    $('#sourceUpload').prop('checked', true).trigger('change');
    $('#card-image-input').val(''); // ล้างค่า input file

    new bootstrap.Modal(document.getElementById('card-form-modal')).show();
}

// 4. ฟังก์ชันบันทึกข้อมูล (Save)
async function handleSaveCard(e) {
    e.preventDefault();
    const btn = $(this).find('button[type="submit"]');
    btn.prop('disabled', true).text('กำลังบันทึก...');

    try {
        // ... (ส่วนจัดการรูปภาพเหมือนเดิม) ...
        const mode = $('input[name="imgSource"]:checked').val();
        let finalImageUrl = $('#card-image-final-url').val();

        if (mode === 'upload') {
            const fileInput = $('#card-image-input')[0];
            if (fileInput.files.length > 0) {
                finalImageUrl = await uploadImage(fileInput.files[0]);
            }
        } else {
            const urlInput = $('#card-image-url-text').val().trim();
            if (urlInput) finalImageUrl = urlInput;
        }
        // ...

        const payload = {
            cardId: $('#card-id').val(), // ⭐ เช็คตรงนี้
            cardName: $('#card-name').val(),
            description: $('#card-desc').val(),
            rarity: $('#card-rarity').val(),
            imageUrl: finalImageUrl
        };

        // ⭐ ถ้ามี ID ให้ใช้ PUT (แก้ไข)
        const method = payload.cardId ? 'PUT' : 'POST';
        await callApi('/api/admin/cards', payload, method);
        
        // ปิด Modal และรีเฟรชลิสต์
        bootstrap.Modal.getInstance(document.getElementById('card-form-modal')).hide();
        showSuccess('บันทึกข้อมูลเรียบร้อย');

        // รีเฟรช card list โดยตรง ไม่ต้อง hide/show modal ใหม่
        const cards = await callApi('/api/admin/cards');
        AppState._cachedCards = cards;
        renderFilteredCards(cards, $('#card-search-input').val() || '');

    } catch (e) {
        showError(e.message);
    } finally {
        btn.prop('disabled', false).text('บันทึกข้อมูล');
    }
}

async function handleDeleteCard() {
    const id = $(this).data('id');
    const result = await Swal.fire({
        title: 'ยืนยันการลบ?',
        text: "ผู้เล่นที่มีการ์ดใบนี้อยู่ การ์ดจะหายไปจากสมุดสะสมของพวกเขาด้วย!",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'ลบเลย'
    });

    if (result.isConfirmed) {
        try {
            await callApi(`/api/admin/cards/${id}`, {}, 'DELETE');
            showSuccess('ลบเรียบร้อย');

            // รีเฟรช card list โดยตรง
            const cards = await callApi('/api/admin/cards');
            AppState._cachedCards = cards;
            renderFilteredCards(cards, $('#card-search-input').val() || '');

        } catch (e) {
            showError(e.message);
        }
    }
}

// --- EXCHANGE SYSTEM ---

async function openExchangeModal() {
    const currentCoins = parseInt($('#coin-display').text().replace(/,/g, '')) || 0;
    const currentScore = AppState.currentUser ? AppState.currentUser.totalScore : 0;

    const { value: direction } = await Swal.fire({
        title: 'แลกแต้ม',
        html: `
            <p class="text-muted mb-3" style="font-size:0.9rem;">เลือกทิศทางที่ต้องการแลก</p>
            <div class="d-flex flex-column gap-2">
                <button id="swal-btn-coins" class="btn btn-warning w-100 py-3">
                    <i class="fas fa-coins me-2"></i>
                    <b>10 เหรียญ → 2 คะแนน</b>
                    <div class="small opacity-75 mt-1">คงเหลือ: ${currentCoins.toLocaleString()} เหรียญ</div>
                </button>
                <button id="swal-btn-score" class="btn btn-success w-100 py-3">
                    <i class="fas fa-star me-2"></i>
                    <b>2 คะแนน → 10 เหรียญ</b>
                    <div class="small opacity-75 mt-1">คงเหลือ: ${currentScore.toLocaleString()} คะแนน</div>
                </button>
            </div>
        `,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'ยกเลิก',
        cancelButtonColor: '#6c757d',
        didOpen: () => {
            document.getElementById('swal-btn-coins').addEventListener('click', () => Swal.close({ value: 'coins' }));
            document.getElementById('swal-btn-score').addEventListener('click', () => Swal.close({ value: 'score' }));
        }
    });

    if (direction === 'coins') exchangeCoinsToScore();
    else if (direction === 'score') exchangeScoreToCoins();
}

async function exchangeScoreToCoins() {
    const SCORE_COST = 2;
    const COIN_GAIN = 10;
    const currentScore = AppState.currentUser ? AppState.currentUser.totalScore : 0;

    if (currentScore < SCORE_COST) {
        return Swal.fire({
            icon: 'warning',
            title: 'คะแนนไม่พอ!',
            text: `ต้องใช้ ${SCORE_COST} คะแนน เพื่อแลก ${COIN_GAIN} เหรียญ`,
            confirmButtonText: 'โอเค',
            confirmButtonColor: '#6c757d'
        });
    }

    const confirm = await Swal.fire({
        title: 'ยืนยันการแลก?',
        html: `คุณต้องการใช้ <b class="text-success">${SCORE_COST} คะแนน</b><br>เพื่อแลกรับ <b class="text-warning">${COIN_GAIN} เหรียญ</b> ใช่ไหม?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'แลกเลย!',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#06C755',
        cancelButtonColor: '#6c757d',
        reverseButtons: true
    });

    if (!confirm.isConfirmed) return;

    triggerHaptic('medium');
    Swal.fire({ title: 'กำลังแลกเปลี่ยน...', showConfirmButton: false, allowOutsideClick: false, timer: 1000 });

    try {
        const res = await callApi('/api/game/exchange-score', { lineUserId: AppState.lineProfile.userId }, 'POST');
        syncCoins(res.newCoinBalance);
        if (AppState.currentUser) AppState.currentUser.totalScore = res.newTotalScore;
        $('#user-score, #profile-page-score').text(res.newTotalScore);
        triggerHaptic('heavy');
        Swal.fire({
            icon: 'success',
            title: 'แลกสำเร็จ!',
            html: `ยอดคงเหลือ: <b class="text-success">${res.newTotalScore} คะแนน</b><br>เหรียญใหม่: <b class="text-warning">${res.newCoinBalance} เหรียญ</b>`,
            confirmButtonText: 'ตกลง',
            confirmButtonColor: '#06C755'
        });
    } catch (e) {
        Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
    }
}

async function exchangeCoinsToScore() {
    // 1. ดึงค่าเหรียญปัจจุบันจากหน้าจอมาเช็คเบื้องต้น
    // ⭐ แก้ตรงนี้: สั่งลบลูกน้ำ (,) ออกก่อนแปลงเป็นตัวเลข
    const currentCoins = parseInt($('#coin-display').text().replace(/,/g, '')) || 0;
    
    if (currentCoins < 10) {
        return Swal.fire({
            icon: 'warning',
            title: 'เหรียญไม่พอ!',
            text: 'ต้องใช้ 10 เหรียญ เพื่อแลก 2 คะแนน\nไปเล่นเกมสะสมเหรียญก่อนนะ',
            confirmButtonText: 'โอเค',
            confirmButtonColor: '#6c757d'
        });
    }

    // 2. ถามยืนยัน (Confirmation)
    const result = await Swal.fire({
        title: 'ยืนยันการแลก?',
        html: `คุณต้องการใช้ <b class="text-warning">10 เหรียญ</b><br>เพื่อแลกรับ <b class="text-success">2 คะแนน</b> ใช่ไหม?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'แลกเลย!',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#FFC107', // สีทอง
        cancelButtonColor: '#d33',
        reverseButtons: true
    });

    if (result.isConfirmed) {
        triggerHaptic('medium'); // สั่นตอบรับ

        // Animation: เหรียญหมุน
        Swal.fire({
            title: 'กำลังแลกเปลี่ยน...',
            html: '<lottie-player src="https://assets10.lottiefiles.com/packages/lf20_p8bfn5to.json" background="transparent" speed="1" style="width: 150px; height: 150px; margin: 0 auto;" loop autoplay></lottie-player>',
            showConfirmButton: false,
            allowOutsideClick: false,
            timer: 1500 // หน่วงเวลาหน่อยให้ดูสมจริง
        });

        try {
            const res = await callApi('/api/game/exchange-coins', { lineUserId: AppState.lineProfile.userId }, 'POST');

            // อัปเดต UI ทันที
            syncCoins(res.remainingCoins);
            $('#user-score, #profile-page-score').text(res.newTotalScore);
            if (AppState.currentUser) AppState.currentUser.totalScore = res.newTotalScore;

            triggerHaptic('heavy'); // สั่นสำเร็จ

            Swal.fire({
                icon: 'success',
                title: 'แลกสำเร็จ!',
                html: `
                    <div class="d-flex justify-content-center">
                        <lottie-player src="https://assets9.lottiefiles.com/packages/lf20_lk80fpsm.json" background="transparent" speed="1" style="width: 120px; height: 120px;" autoplay></lottie-player>
                    </div>
                    <p>ยอดคงเหลือ: <b>${res.remainingCoins} เหรียญ</b><br>คะแนนสะสมใหม่: <b class="text-success">${res.newTotalScore} คะแนน</b></p>
                `,
                confirmButtonText: 'ตกลง',
                confirmButtonColor: '#06C755'
            });

        } catch (e) {
            Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
        }
    }
}

// --- RECYCLE SYSTEM (ระบบย่อยการ์ด) ---

let selectedRecycleCards = {}; // ตัวแปรเก็บการ์ดที่เลือก

async function openRecycleModal() {
    selectedRecycleCards = {};
    updateRecycleUI();
    
    // เปิด Modal
    const modal = new bootstrap.Modal(document.getElementById('recycle-modal'));
    modal.show();
    
    const list = $('#recycle-list');
    list.html('<div class="text-center py-4"><div class="spinner-border"></div></div>');

    try {
        // ดึงการ์ดทั้งหมด
        const cards = await callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId });
        
        // กรองเอาเฉพาะที่มีซ้ำ (count > 1)
        const duplicates = cards.filter(c => c.count > 1);
        
        list.empty();
        
        if (duplicates.length === 0) {
            list.html('<div class="text-center text-muted py-4"><i class="fas fa-box-open fa-3x mb-2"></i><br>ไม่มีการ์ดซ้ำให้ย่อย</div>');
            return;
        }

        duplicates.forEach(c => {
            const spareCount = c.count - 1; // จำนวนที่ย่อยได้ (ต้องเหลือไว้ 1 ใบ)
            
            list.append(`
                <div class="list-group-item d-flex align-items-center justify-content-between p-3 border-0 shadow-sm mb-2 rounded">
                    <div class="d-flex align-items-center">
                        <img src="${getFullImageUrl(c.imageUrl)}" class="rounded me-3 border" style="width: 50px; height: 50px; object-fit: cover;">
                        <div>
                            <h6 class="mb-0 fw-bold">${c.cardName}</h6>
                            <small class="text-muted">มีซ้ำ ${spareCount} ใบ</small>
                        </div>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <button class="btn btn-sm btn-outline-secondary rounded-circle" style="width:32px; height:32px;" 
                                onclick="adjustRecycle('${c.cardId}', -1, ${spareCount})"><i class="fas fa-minus"></i></button>
                        <span class="fw-bold" id="qty-${c.cardId}" style="width: 20px; text-align: center;">0</span>
                        <button class="btn btn-sm btn-outline-success rounded-circle" style="width:32px; height:32px;" 
                                onclick="adjustRecycle('${c.cardId}', 1, ${spareCount})"><i class="fas fa-plus"></i></button>
                    </div>
                </div>
            `);
        });

    } catch (e) {
        list.html(`<p class="text-danger text-center">Error: ${e.message}</p>`);
    }
}

function adjustRecycle(cardId, delta, max) {
    const current = selectedRecycleCards[cardId] || 0;
    let next = current + delta;
    
    if (next < 0) next = 0;
    if (next > max) next = max;

    const totalSelected = Object.values(selectedRecycleCards).reduce((a, b) => a + b, 0);
    if (delta > 0 && (totalSelected >= 5) && next > current) return; // ห้ามเกิน 5

    if (next === 0) delete selectedRecycleCards[cardId];
    else selectedRecycleCards[cardId] = next;

    $(`#qty-${cardId}`).text(next);
    updateRecycleUI();
}

function updateRecycleUI() {
    const total = Object.values(selectedRecycleCards).reduce((a, b) => a + b, 0);
    $('#recycle-slot-count').text(`${total} / 5`);
    
    const btn = $('#btn-confirm-recycle');
    if (total === 5) {
        btn.prop('disabled', false).removeClass('btn-dark').addClass('btn-danger');
        $('#recycle-slot-count').removeClass('bg-secondary').addClass('bg-success');
    } else {
        btn.prop('disabled', true).removeClass('btn-danger').addClass('btn-dark');
        $('#recycle-slot-count').removeClass('bg-success').addClass('bg-secondary');
    }
}

async function confirmRecycle() {
    const cardsToRecycle = Object.keys(selectedRecycleCards).map(id => ({
        cardId: id,
        count: selectedRecycleCards[id]
    }));

    triggerHaptic('medium');

    // Animation
    Swal.fire({
        title: 'กำลังหลอมรวม...',
        html: '<div class="spinner-border text-danger"></div><p class="mt-2">เครื่องจักรกำลังทำงาน...</p>',
        showConfirmButton: false,
        timer: 2000
    });

    try {
        await new Promise(r => setTimeout(r, 2000));
        const res = await callApi('/api/game/recycle-cards', { 
            lineUserId: AppState.lineProfile.userId,
            cardsToRecycle 
        }, 'POST');

        bootstrap.Modal.getInstance(document.getElementById('recycle-modal'))?.hide();
        $('#coin-display').text(res.newCoinBalance);
        if(AppState.currentUser) AppState.currentUser.coinBalance = res.newCoinBalance;

        triggerHaptic('heavy');
        Swal.fire('สำเร็จ!', `คุณได้รับ +${res.rewardCoins} เหรียญ`, 'success');

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// --- ADMIN QUESTION: Image Toggle Logic ---

// ใส่ไว้ใน document.ready หรือที่ไหนก็ได้ที่รันทีเดียว
$(document).on('change', 'input[name="q-imgSource"]', function() {
    const mode = $(this).val();
    if(mode === 'upload') {
        $('#q-input-group-upload').show();
        $('#q-input-group-url').hide();
    } else {
        $('#q-input-group-upload').hide();
        $('#q-input-group-url').show();
    }
});

$('#q-image-url-text').on('input', function() {
    const url = $(this).val().trim();
    if(url) {
        $('#q-image-preview').attr('src', url).show();
        $('#q-no-preview-text').hide();
    } else {
        $('#q-image-preview').hide();
        $('#q-no-preview-text').show();
    }
});

// Preview เมื่อเลือกไฟล์ (File Input)
$('#q-image-input').on('change', function() {
    if (this.files && this.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) { 
            $('#q-image-preview').attr('src', e.target.result).show();
            $('#q-no-preview-text').hide();
        }
        reader.readAsDataURL(this.files[0]);
    }
});

// ==========================================
// --- SAFETY HUNTER SYSTEM (FULL VERSION: Hearts + Timer + Education) ---
// ==========================================

// Global Variables
let hunterLevelData = null;
let hunterFound = new Set();
let editorHazards = [];
let hunterLives = 3;
let hunterTimerInterval = null;
let hunterTimeLeft = 0; // วินาที

async function openHunterMenu() {
    // 1. เช็คสิทธิ์ Admin (เพื่อโชว์แถบเมนูข้างบน ถ้ามี)
    if (AppState.currentUser && AppState.currentUser.isAdmin) {
        $('#hunter-admin-bar').show();
    } else {
        $('#hunter-admin-bar').hide();
    }

    // 2. เปิด Modal
    if (!AppState.allModals['hunter-menu']) {
        AppState.allModals['hunter-menu'] = new bootstrap.Modal(document.getElementById('hunter-menu-modal'));
    }
    AppState.allModals['hunter-menu'].show();
    
    const list = $('#hunter-levels-list');
    list.html('<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>');

    try {
        // 3. ดึงข้อมูลด่าน
        const levels = await callApi('/api/game/hunter/levels', { lineUserId: AppState.lineProfile.userId });
        list.empty();

        if (levels.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีภารกิจ</div>');
            return;
        }

        // 4. วนลูปสร้างการ์ดด่าน (ดีไซน์ใหม่)
        levels.forEach(l => {
            // Logic สถานะ (เหมือนเดิม)
            let statusBadge = '<span class="badge bg-warning text-dark shadow-sm">🚀 ภารกิจใหม่</span>';
            if (l.isCleared) {
                let starsHtml = '';
                for(let i=1; i<=3; i++) {
                    starsHtml += i <= l.bestStars ? '<i class="fas fa-star text-warning"></i>' : '<i class="far fa-star text-secondary"></i>';
                }
                statusBadge = `<span class="badge bg-white text-dark shadow-sm border">${starsHtml}</span>`;
            }
            
            // Logic Quota (เหมือนเดิม)
            let quotaClass = 'text-white'; 
            let iconColor = 'text-success';
            if(l.playedCount >= l.maxPlays) { 
                quotaClass = 'text-danger'; 
                iconColor = 'text-danger';
            }
            
            const safeTitle = sanitizeHTML(l.title);
            const isLocked = l.playedCount >= l.maxPlays;
            const lockedClass = isLocked ? 'locked' : '';

            // Difficulty badge based on hazard count
            let diffLabel = 'ง่าย', diffBg = 'bg-success';
            if (l.totalHazards >= 4 && l.totalHazards <= 6) { diffLabel = 'กลาง'; diffBg = 'bg-warning text-dark'; }
            if (l.totalHazards >= 7) { diffLabel = 'ยาก'; diffBg = 'bg-danger'; }

            // HTML ใหม่: ใช้ Class mission-card
            list.append(`
                <div class="col-12 col-md-6">
                    <div class="mission-card ${lockedClass} btn-hunter-level"
                        data-level-id="${l.levelId}"
                        data-image-url="${l.imageUrl}"
                        data-hazards="${l.totalHazards}"
                        data-locked="${isLocked}">

                        <div class="mission-img-wrapper">
                            <img src="${getFullImageUrl(l.imageUrl)}" class="mission-img">
                            <div class="mission-status-badge">${statusBadge}</div>
                            <div class="mission-quota-badge ${quotaClass}">
                                <i class="fas fa-ticket-alt ${iconColor} me-1"></i> ${l.playedCount}/${l.maxPlays}
                            </div>
                            <div class="mission-overlay">
                                <h6 class="fw-bold mb-0 text-white text-shadow">${safeTitle}</h6>
                            </div>
                        </div>

                        <div class="p-3 d-flex justify-content-between align-items-center">
                            <div class="d-flex align-items-center gap-2">
                                <small class="text-muted">
                                    <i class="fas fa-crosshairs text-danger me-1"></i>
                                    เป้าหมาย: <b>${l.totalHazards} จุด</b>
                                </small>
                                <span class="badge ${diffBg} difficulty-badge">${diffLabel}</span>
                            </div>
                            <button class="btn btn-sm btn-light rounded-circle shadow-sm">
                                <i class="fas fa-play text-primary"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `);
        });

    } catch (e) {
        list.html(`<div class="text-center text-danger">Error: ${e.message}</div>`);
    }
}

// ⭐ เริ่มเกม (พร้อมจับเวลา)
function startHunterGame(id, imgUrl, total) {
    hunterLevelData = { id, total };
    hunterFound.clear();
    hunterLives = 3; 
    
    // ตั้งเวลา: ให้เวลา 15 วินาทีต่อ 1 จุด (เช่น 5 จุด = 75 วินาที)
    hunterTimeLeft = total * 15; 
    
    $('#hunter-target-img').attr('src', getFullImageUrl(imgUrl));
    $('#hunter-progress').text(`0 / ${total}`);
    
    updateHunterLivesUI();
    updateHunterTimerUI();
    
    $('.hunter-marker').remove(); 
    bootstrap.Modal.getInstance(document.getElementById('hunter-menu-modal'))?.hide();

    if (!AppState.allModals['hunter-game']) {
        AppState.allModals['hunter-game'] = new bootstrap.Modal(document.getElementById('hunter-game-modal'));
    }
    AppState.allModals['hunter-game'].show();

    // เริ่มนับถอยหลัง
    clearInterval(hunterTimerInterval);
    hunterTimerInterval = setInterval(() => {
        hunterTimeLeft--;
        updateHunterTimerUI();

        if (hunterTimeLeft <= 0) {
            endGameByTimeOut();
        }
    }, 1000);
}

// ⭐ ฟังก์ชันใหม่: เช็คสิทธิ์ก่อนเริ่มเล่น (ตัดโควตา)
async function checkQuotaAndStart(id, imgUrl, total) {
    // 1. แสดง Loading กัน User กดรัว
    Swal.fire({
        title: 'กำลังตรวจสอบสิทธิ์...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try {
        // 2. ยิง API ไปตัดโควตา (นับจำนวนครั้ง)
        // สังเกตว่าเราเรียก API ตัวใหม่ที่เราเพิ่งสร้างใน server.js
        await callApi('/api/game/hunter/start-level', { 
            lineUserId: AppState.lineProfile.userId,
            levelId: id 
        }, 'POST');
        
        // 3. ถ้าผ่าน (ไม่ Error) ให้ปิด Loading แล้วเริ่มเกมจริง
        Swal.close();
        startHunterGame(id, imgUrl, total);

    } catch (e) {
        // 4. ถ้าโควตาเต็ม (Backend ส่ง Error กลับมา)
        triggerHaptic('heavy');
        Swal.fire({
            icon: 'error',
            title: 'สิทธิ์เต็มแล้ว!',
            // ข้อความ Error จะมาจาก Backend ว่า "คุณใช้สิทธิ์เล่นด่านนี้ครบ 3 ครั้งแล้ว"
            text: e.message, 
            confirmButtonText: 'ตกลง',
            confirmButtonColor: '#6c757d'
        });
    }
}

// อัปเดต UI นาฬิกา (MM:SS)
function updateHunterTimerUI() {
    const m = Math.floor(hunterTimeLeft / 60);
    const s = hunterTimeLeft % 60;
    const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    $('#hunter-timer').text(timeStr);
    
    // เปลี่ยนสีถ้าเวลาน้อย
    if(hunterTimeLeft <= 10) $('#hunter-timer').removeClass('bg-warning').addClass('bg-danger text-white');
    else $('#hunter-timer').removeClass('bg-danger text-white').addClass('bg-warning text-dark');
}

// อัปเดต UI หัวใจ
function updateHunterLivesUI() {
    let heartsHtml = '';
    for(let i=0; i<3; i++) heartsHtml += i < hunterLives ? "❤️" : "🖤";
    $('#hunter-lives').html(heartsHtml);
}

// หมดเวลา!
function endGameByTimeOut() {
    // เรียกใช้ฟังก์ชันกลาง ส่งหัวข้อและข้อความไป
    handleHunterFail('หมดเวลา!', 'เสียดายจัง เวลาหมดซะก่อน');
}

// ⭐ ฟังก์ชันใหม่: จัดการเมื่อเล่นแพ้ (หยุดเวลา + รับรางวัลปลอบใจ + เด้งออก)
async function handleHunterFail(title, text) {
    clearInterval(hunterTimerInterval); // หยุดเวลา
    triggerHaptic('heavy'); // สั่นยาวๆ

    try {
        // 1. เรียก API รับรางวัลปลอบใจ
        const res = await callApi('/api/game/hunter/fail', {
            lineUserId: AppState.lineProfile.userId,
            levelId: hunterLevelData.id
        }, 'POST');

        // 2. อัปเดตเหรียญบนหน้าจอทันที
        $('#coin-display').text(res.newCoinBalance);
        if(AppState.currentUser) AppState.currentUser.coinBalance = res.newCoinBalance;

        // 3. แสดง Popup แจ้งเตือน + รางวัลปลอบใจ
        Swal.fire({
            icon: 'error',
            title: title,
            html: `
                <p>${text}</p>
                <div class="mt-3 p-2 bg-light rounded border">
                    <small class="text-muted">รางวัลความพยายาม</small><br>
                    <span class="text-warning fw-bold fs-4">+${res.earnedCoins} เหรียญ 💰</span>
                </div>
            `,
            confirmButtonText: 'กลับสู่เมนู',
            confirmButtonColor: '#6c757d',
            allowOutsideClick: false
        }).then(() => {
            // 4. ปิดเกม กลับเมนู
            AppState.allModals['hunter-game'].hide();
            openHunterMenu();
        });

    } catch (e) {
        console.error("Fail reward error:", e);
        // กรณี Error (เน็ตหลุด) ก็ให้เด้งออกปกติ
        AppState.allModals['hunter-game'].hide();
        openHunterMenu();
    }
}

// ⭐ User คลิกหารูป (Logic ที่ถูกต้อง: ลบโค้ดซ้ำซ้อนออกแล้ว)
$(document).on('click', '#hunter-target-img', async function(e) {
    // เช็คสถานะก่อน ถ้าจบเกมแล้วห้ามคลิกต่อ
    if (hunterLives <= 0 || hunterFound.size >= hunterLevelData.total || hunterTimeLeft <= 0) return;

    const img = $(this);
    const offset = img.offset(); 
    const x = ((e.pageX - offset.left) / img.width()) * 100;
    const y = ((e.pageY - offset.top) / img.height()) * 100;

    try {
        const res = await callApi('/api/game/hunter/check', {
            levelId: hunterLevelData.id, x, y
        }, 'POST');

        if (res.isHit) {
            // --- กรณีเจอจุดเสี่ยง ---
            const h = res.hazard;
            if (!hunterFound.has(h.hazardId)) {
                // หยุดเวลาชั่วคราวขณะอ่านความรู้
                clearInterval(hunterTimerInterval); 
                
                hunterFound.add(h.hazardId);
                triggerHaptic('medium');

                // สร้าง Marker (ใช้ Class จาก CSS แล้ว)
                const marker = $('<div class="hunter-marker"></div>').css({
                    left: h.x + '%', 
                    top: h.y + '%'
                });
                $('#hunter-game-area').append(marker);
                $('#hunter-progress').text(`${hunterFound.size} / ${hunterLevelData.total}`);

                // แสดง Popup ความรู้
                await Swal.fire({
                    icon: 'success',
                    title: 'เจอจุดเสี่ยง!',
                    html: `
                        <h5 class="fw-bold text-danger">${h.description}</h5>
                        <div class="alert alert-info text-start mt-3">
                            <i class="fas fa-lightbulb text-warning me-2"></i>
                            <small>${h.knowledge || 'ระมัดระวังและแจ้งหัวหน้างานทันที'}</small>
                        </div>
                    `,
                    confirmButtonText: 'เข้าใจแล้ว (ไปต่อ)',
                    confirmButtonColor: '#06C755',
                    allowOutsideClick: false
                });

                // เล่นต่อหรือจบเกม?
                if (hunterFound.size === hunterLevelData.total) {
                    finishHunterGame();
                } else {
                    // เดินเวลาต่อ
                    hunterTimerInterval = setInterval(() => {
                        hunterTimeLeft--;
                        updateHunterTimerUI();
                        if (hunterTimeLeft <= 0) endGameByTimeOut();
                    }, 1000);
                }
            }
        } else {
            // --- กรณีผิด (Miss) ---
            hunterLives--;
            updateHunterLivesUI();
            triggerHaptic('heavy');

            // แสดงกากบาทแดง
            const miss = $('<div class="fas fa-times text-danger fs-1"></div>').css({
                position: 'absolute', left: x + '%', top: y + '%',
                transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 10
            }).fadeOut(1000, function() { $(this).remove(); });
            $('#hunter-game-area').append(miss);

            // เช็คว่าตายหรือยัง
            if (hunterLives <= 0) {
                // ⭐ เรียกฟังก์ชันจบเกมแบบแพ้ (รับรางวัลปลอบใจ + เด้งออก)
                handleHunterFail('Game Over!', 'คุณจิ้มผิดเกิน 3 ครั้ง ภารกิจล้มเหลว');
            }
        }
    } catch (e) { console.error(e); }
});

// จบเกม
async function finishHunterGame() {
    clearInterval(hunterTimerInterval); // หยุดเวลา
    triggerHaptic('heavy');
    
    // ⭐ คำนวณดาว: เหลือ 3 หัวใจ = 3 ดาว, 2 หัวใจ = 2 ดาว, 1 หัวใจ = 1 ดาว
    const stars = hunterLives; 
    
    // สร้าง HTML ดาวสำหรับโชว์ใน Popup
    let starsDisplay = '';
    for(let i=1; i<=3; i++) {
        if(i <= stars) starsDisplay += '<i class="fas fa-star text-warning fa-2x mx-1"></i>';
        else starsDisplay += '<i class="far fa-star text-muted fa-2x mx-1"></i>';
    }

    Swal.fire({
        title: 'ภารกิจสำเร็จ!',
        html: `
            <div class="mb-3">${starsDisplay}</div>
            <p>คุณค้นหาครบทุกจุดแล้ว!</p>
            <p class="small text-muted">เวลาคงเหลือ: ${hunterTimeLeft} วินาที</p>
        `,
        icon: 'success',
        confirmButtonText: 'รับรางวัล / จบเกม',
        confirmButtonColor: '#06C755',
        allowOutsideClick: false
    }).then(async () => {
        try {
            // ส่ง stars ไปบันทึกด้วย
            const res = await callApi('/api/game/hunter/complete', {
                lineUserId: AppState.lineProfile.userId,
                levelId: hunterLevelData.id,
                stars: stars // ⭐ ส่งค่าดาวไป
            }, 'POST');

            if (res.earnedCoins > 0) {
                Swal.fire('ยินดีด้วย!', `ได้รับรางวัลภารกิจครั้งแรก ${res.earnedCoins} เหรียญ`, 'success');
                $('#coin-display').text(res.newCoinBalance);
                if(AppState.currentUser) AppState.currentUser.coinBalance = res.newCoinBalance;
            } else {
                Swal.fire('บันทึกผลเรียบร้อย', 'คุณได้บันทึกสถิติดาวรอบนี้แล้ว', 'success');
            }
            AppState.allModals['hunter-game'].hide();
            openHunterMenu(); // รีโหลดเมนูเพื่อโชว์ดาวใหม่
        } catch (e) { Swal.fire('Error', e.message, 'error'); }
    });
}

// ⭐ ฟังก์ชันจัดการเมื่อเล่นแพ้ (หัวใจหมด หรือ เวลาหมด)
async function handleHunterFail(title, text) {
    clearInterval(hunterTimerInterval); // หยุดเวลา
    triggerHaptic('heavy'); // สั่นยาวๆ

    try {
        // เรียก API รับรางวัลปลอบใจ
        const res = await callApi('/api/game/hunter/fail', {
            lineUserId: AppState.lineProfile.userId,
            levelId: hunterLevelData.id
        }, 'POST');

        // อัปเดตเหรียญบนหน้าจอทันที
        $('#coin-display').text(res.newCoinBalance);
        if(AppState.currentUser) AppState.currentUser.coinBalance = res.newCoinBalance;

        // แสดง Popup แจ้งเตือน + รางวัลปลอบใจ
        Swal.fire({
            icon: 'error', // ใช้ icon error เพื่อบอกว่าภารกิจล้มเหลว
            title: title,
            html: `
                <p>${text}</p>
                <div class="mt-3 p-2 bg-light rounded border">
                    <small class="text-muted">รางวัลความพยายาม</small><br>
                    <span class="text-warning fw-bold fs-4">+${res.earnedCoins} เหรียญ 💰</span>
                </div>
            `,
            confirmButtonText: 'กลับสู่เมนู',
            confirmButtonColor: '#6c757d',
            allowOutsideClick: false
        }).then(() => {
            // ปิดเกม กลับเมนู (เพื่อนับ Quota ใหม่ถ้าจะเล่นอีก)
            AppState.allModals['hunter-game'].hide();
            openHunterMenu();
        });

    } catch (e) {
        console.error("Fail reward error:", e);
        // กรณี Error (เน็ตหลุด) ก็ให้เด้งออกปกติ
        AppState.allModals['hunter-game'].hide();
        openHunterMenu();
    }
}

// ----------------------------------------------------
// ⭐ ADMIN SECTION (Updated for Knowledge Input)
// ----------------------------------------------------

function openHunterEditor() {
    // ⭐ 1. แก้บั๊ก Focus ค้าง (สำคัญมาก)
    if (document.activeElement) {
        document.activeElement.blur(); 
    }

    editorHazards = [];
    editingLevelId = null;
    
    // รีเซ็ตค่าฟอร์ม
    $('#editor-title').val('');
    $('#editor-file').val(''); 
    $('#editor-url-text').val(''); // ล้างช่อง URL
    $('#editor-image-original').val('');
    $('#hunter-sourceUpload').prop('checked', true).trigger('change'); // กลับไปโหมด Upload

    $('#editor-preview-img').attr('src', '').parent().hide();
    $('#editor-placeholder').show();
    renderEditorHazards();
    $('#hunter-editor-modal .modal-title').text('สร้างด่านใหม่');
    
    // ปิด Modal อื่นๆ
    if(AppState.allModals['hunter-menu']) AppState.allModals['hunter-menu'].hide();
    if(AppState.allModals['admin-hunter-manage']) AppState.allModals['admin-hunter-manage'].hide();
    
    // สร้าง Modal ใหม่แบบไม่เอา Focus (แก้ปัญหาพิมพ์ไม่ได้)
    const modalEl = document.getElementById('hunter-editor-modal');
    if (AppState.allModals['hunter-editor']) {
        AppState.allModals['hunter-editor'].dispose();
    } else {
        const existingInstance = bootstrap.Modal.getInstance(modalEl);
        if (existingInstance) existingInstance.dispose();
    }

    AppState.allModals['hunter-editor'] = new bootstrap.Modal(modalEl, { focus: false });
    AppState.allModals['hunter-editor'].show();
}

// Admin: อัปโหลดรูป
$(document).on('change', '#editor-file', function() {
    const file = this.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            $('#editor-preview-img').attr('src', e.target.result).parent().show();
            $('#editor-placeholder').hide();
            editorHazards = [];
            renderEditorHazards();
            $('.editor-marker').remove();
        };
        reader.readAsDataURL(file);
    }
});

// Admin: คลิกเพิ่มจุด (แก้ให้กรอก Knowledge ได้)
$(document).on('click', '#editor-preview-img', function(e) {
    const img = $(this);
    const offset = img.offset();
    const x = ((e.pageX - offset.left) / img.width()) * 100;
    const y = ((e.pageY - offset.top) / img.height()) * 100;

    // ⭐ ใช้ HTML Form ใน SweetAlert เพื่อรับ 2 ค่า (ชื่อ + ความรู้)
    Swal.fire({
        title: 'เพิ่มจุดเสี่ยง',
        // ⭐ เพิ่มบรรทัดนี้: สั่งให้ Swal ไปเกิดใน Modal แทนที่จะไปเกิดที่ Body
        target: document.getElementById('hunter-editor-modal'),       
        html: `
            <input id="swal-input1" class="swal2-input" placeholder="ชื่อจุดเสี่ยง (เช่น สายไฟชำรุด)">
            <textarea id="swal-input2" class="swal2-textarea" placeholder="ความรู้/วิธีแก้ไข (เช่น แจ้งช่างซ่อมทันที)"></textarea>
        `,
        focusConfirm: false,
        target: '#hunter-editor-modal', // แก้ Focus Blocked
        showCancelButton: true,
        confirmButtonText: 'บันทึก',
        preConfirm: () => {
            const desc = document.getElementById('swal-input1').value;
            const know = document.getElementById('swal-input2').value;
            if (!desc) Swal.showValidationMessage('กรุณากรอกชื่อจุดเสี่ยง');
            return { description: desc, knowledge: know };
        }
    }).then((res) => {
        if (res.isConfirmed) {
            editorHazards.push({ 
                x, y, 
                description: res.value.description,
                knowledge: res.value.knowledge 
            });
            renderEditorHazards();
            
            const marker = $('<div class="editor-marker">!</div>').css({
                position: 'absolute', left: x + '%', top: y + '%',
                width: '30px', height: '30px', background: 'red', color: 'white', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold',
                transform: 'translate(-50%, -50%)', pointerEvents: 'none', boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
            });
            $('#editor-area').append(marker);
        }
    });
});

function renderEditorHazards() {
    const list = $('#editor-list');
    list.empty();
    $('#editor-count').text(editorHazards.length);
    editorHazards.forEach((h, i) => list.append(`
        <li class="list-group-item small py-1">
            <b>${i+1}. ${h.description}</b><br>
            <span class="text-muted" style="font-size:0.8em">${h.knowledge || '-'}</span>
        </li>
    `));
}

async function saveHunterLevel() {
    const title = $('#editor-title').val();
    const isEditMode = !!editingLevelId;
    
    // ⭐ ตรวจสอบว่าจะเอารูปจากไหน
    const mode = $('input[name="hunter-img-source"]:checked').val();
    const file = $('#editor-file')[0].files[0];
    const urlText = $('#editor-url-text').val().trim();
    const originalUrl = $('#editor-image-original').val();

    let finalImageUrl = originalUrl;

    if (mode === 'upload') {
        if (!file && !isEditMode) return Swal.fire('ข้อมูลไม่ครบ', 'กรุณาอัปโหลดรูปภาพ', 'warning');
    } else {
        // โหมด URL
        if (urlText) finalImageUrl = urlText;
        else if (!isEditMode) return Swal.fire('ข้อมูลไม่ครบ', 'กรุณาใส่ลิงก์รูปภาพ', 'warning');
    }

    if (!title || editorHazards.length === 0) {
        return Swal.fire('ข้อมูลไม่ครบ', 'ต้องมีชื่อด่าน และจุดเสี่ยงอย่างน้อย 1 จุด', 'warning');
    }

    Swal.fire({ title: 'กำลังบันทึก...', didOpen: () => Swal.showLoading() });

    try {
        // อัปโหลดไฟล์ถ้าเลือกโหมด Upload และมีไฟล์
        if (mode === 'upload' && file) {
            finalImageUrl = await uploadImage(file);
        }

        const payload = { 
            title, 
            imageUrl: finalImageUrl, 
            hazards: editorHazards 
        };

        if (isEditMode) {
            payload.levelId = editingLevelId;
            await callApi('/api/admin/hunter/level/update', payload, 'POST');
        } else {
            await callApi('/api/admin/hunter/level', payload, 'POST');
        }
        
        Swal.fire('สำเร็จ', 'บันทึกข้อมูลเรียบร้อย', 'success');
        AppState.allModals['hunter-editor'].hide();
        editingLevelId = null;
        handleManageHunterLevels();

    } catch (e) { Swal.fire('Error', e.message, 'error'); }
}

// --- ADMIN: ลบด่าน ---
async function deleteHunterLevel(levelId) {
    const result = await Swal.fire({
        title: 'ยืนยันการลบ?',
        text: "ข้อมูลประวัติการเล่นและสถิติทั้งหมดของด่านนี้จะหายไป!",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'ลบเลย'
    });

    if (result.isConfirmed) {
        try {
            await callApi(`/api/admin/hunter/level/${levelId}`, {}, 'DELETE');
            Swal.fire('เรียบร้อย', 'ลบด่านแล้ว', 'success');
            // ⭐ เปลี่ยนจาก openHunterMenu() เป็น:
            handleManageHunterLevels();
        } catch (e) {
            Swal.fire('Error', e.message, 'error');
        }
    }
}

// --- ADMIN: เตรียมแก้ไขด่าน ---
let editingLevelId = null; // ตัวแปรเก็บ ID ด่านที่กำลังแก้

// --- ADMIN: เตรียมแก้ไขด่าน (ฉบับ Final: แก้ Console Warning) ---
async function editHunterLevel(levelId) {
    // ⭐ 1. แก้บั๊ก Console Warning (สั่งปลด Focus ออกจากปุ่มเดิมทันที)
    if (document.activeElement) {
        document.activeElement.blur();
    }

    Swal.fire({ title: 'กำลังโหลดข้อมูล...', didOpen: () => Swal.showLoading() });
    
    try {
        const res = await callApi(`/api/admin/hunter/level/${levelId}`);
        const data = res; 

        // 2. ตั้งค่าตัวแปร
        editingLevelId = levelId;
        editorHazards = data.hazards.map(h => ({
            x: h.x, y: h.y, description: h.description, knowledge: h.knowledge
        }));

        // 3. ใส่ข้อมูลลงฟอร์ม
        $('#editor-title').val(data.title);
        
        // จัดการรูปภาพ (รองรับทั้ง Upload และ URL)
        const imgUrl = getFullImageUrl(data.imageUrl);
        $('#editor-preview-img').attr('src', imgUrl).parent().show();
        $('#editor-placeholder').hide();
        
        $('#editor-file').val(''); 
        $('#editor-url-text').val(data.imageUrl); 
        $('#editor-image-original').val(data.imageUrl); 
        
        // รีเซ็ต Radio
        $('#hunter-sourceUpload').prop('checked', true).trigger('change');

        $('#hunter-editor-modal .modal-title').text('แก้ไขด่าน');
        
        // 4. วาดจุดแดงเดิม
        renderEditorHazards(); 
        $('.editor-marker').remove(); 
        
        editorHazards.forEach(h => {
             const marker = $('<div class="editor-marker">!</div>').css({
                position: 'absolute', 
                left: h.x + '%', 
                top: h.y + '%',
                width: '30px', height: '30px', 
                background: 'red', color: 'white', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', 
                fontWeight: 'bold',
                transform: 'translate(-50%, -50%)', 
                pointerEvents: 'none', 
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                zIndex: 10
            });
            $('#editor-area').append(marker);
        });

        // 5. ปิด Modal เก่า
        if(AppState.allModals['hunter-menu']) AppState.allModals['hunter-menu'].hide();
        if(AppState.allModals['admin-hunter-manage']) AppState.allModals['admin-hunter-manage'].hide();
        
        Swal.close();

        // 6. สร้าง Modal ใหม่ (Force Re-create เพื่อแก้ Focus Issue)
        const modalEl = document.getElementById('hunter-editor-modal');
        if (AppState.allModals['hunter-editor']) {
            AppState.allModals['hunter-editor'].dispose();
        } else {
            const existing = bootstrap.Modal.getInstance(modalEl);
            if(existing) existing.dispose();
        }

        AppState.allModals['hunter-editor'] = new bootstrap.Modal(modalEl, { focus: false });
        AppState.allModals['hunter-editor'].show();

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// ⭐ ตัวดักจับการคลิกการ์ดด่าน Hunter (ปลอดภัยกว่า onclick)
$(document).on('click', '.btn-hunter-level', function() {
    // 1. ดึงข้อมูลจาก data-attribute
    const levelId = $(this).data('level-id');
    const imageUrl = $(this).data('image-url');
    const hazards = $(this).data('hazards');
    const isLocked = $(this).data('locked');

    // 2. ถ้าล็อคอยู่ ให้แจ้งเตือนและไม่ให้เข้า
    if (isLocked === true || isLocked === "true") {
        triggerHaptic('light');
        Swal.fire({
            icon: 'info',
            title: 'สิทธิ์เต็มแล้ว',
            text: 'คุณใช้โควตาสำหรับด่านนี้ครบแล้วครับ',
            confirmButtonText: 'ตกลง'
        });
        return;
    }

    // 3. เรียกฟังก์ชันเช็คสิทธิ์และเริ่มเกม
    checkQuotaAndStart(levelId, imageUrl, hazards);
});

// =========================================
// ✨ UI/UX HELPER FUNCTIONS
// =========================================

// 1. ฟังก์ชันทำตัวเลขวิ่ง (Coin Counter Animation)
function animateCoinChange(newBalance) {
    const coinElement = $('#coin-display');
    // ดึงค่าเก่ามา (ถ้าไม่มีให้เป็น 0)
    const startValue = parseInt(coinElement.text().replace(/,/g, '')) || 0;
    const endValue = newBalance;
    const duration = 1500; // ระยะเวลาวิ่ง (ms)
    
    if (startValue === endValue) return;

    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        // คำนวณค่าปัจจุบัน based on progress
        const currentValue = Math.floor(progress * (endValue - startValue) + startValue);
        // อัปเดตหน้าจอ พร้อมใส่ลูกน้ำ
        coinElement.text(currentValue.toLocaleString());
        
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            // จบการทำงาน: เซ็ตค่าสุดท้ายให้เป๊ะ
             coinElement.text(endValue.toLocaleString());
        }
    };
    window.requestAnimationFrame(step);
}

// --- LOGIC: แก้ไขผู้ใช้แบบ Real-time ---

// 1. กดปุ่มแก้ไข -> เปิด Modal พร้อมดึงข้อมูลเก่ามาโชว์
// แก้ไข: โค้ดส่วนกดปุ่มดินสอ (วางทับของเดิมท้ายไฟล์ app.js)
$(document).on('click', '.btn-edit-user-full', function(e) {
    e.stopPropagation(); 
    
    // decode ข้อมูล
    const user = JSON.parse(decodeURIComponent($(this).attr('data-user')));

    // Debug ดูค่าใน Console (กด F12 ดูได้ว่า coinBalance มาไหม)
    console.log("Editing User Data:", user);

    $('#edit-user-id').val(user.lineUserId);
    $('#edit-user-name').val(user.fullName);
    $('#edit-user-empid').val(user.employeeId);
    
    // ⭐ แก้จุดนี้: เช็คให้ชัวร์ว่าถ้าไม่มีค่า ให้ใส่ 0
    $('#edit-user-coins').val((user.coinBalance !== undefined && user.coinBalance !== null) ? user.coinBalance : 0);
    $('#edit-user-score').val((user.totalScore !== undefined && user.totalScore !== null) ? user.totalScore : 0);

    new bootstrap.Modal(document.getElementById('admin-edit-user-modal')).show();
});

// 2. กดบันทึก -> ยิง API -> รีเฟรชตาราง
$('#admin-edit-user-form').on('submit', async function(e) {
    e.preventDefault();
    
    const payload = {
        lineUserId: $('#edit-user-id').val(),
        fullName: $('#edit-user-name').val(),
        employeeId: $('#edit-user-empid').val(),
        coinBalance: parseInt($('#edit-user-coins').val()) || 0,
        totalScore: parseInt($('#edit-user-score').val()) || 0
    };

    try {
        await callApi('/api/admin/user/update-full', payload, 'POST');
        
        Swal.fire('สำเร็จ', 'อัปเดตข้อมูลเรียบร้อย', 'success');
        bootstrap.Modal.getInstance(document.getElementById('admin-edit-user-modal'))?.hide();

        // ⭐ หัวใจสำคัญ: สั่งโหลดข้อมูลใหม่ทันที เพื่อให้ตารางอัปเดต
        loadUsersForAdmin(); 

    } catch (err) {
        Swal.fire('Error', err.message, 'error');
    }
});

// ต้องมีตัวนี้อยู่ที่ท้ายไฟล์ app.js
function updateCollectionProgressBar(ownedCount, totalCount) {
    if (totalCount === 0) return;
    const percentage = Math.round((ownedCount / totalCount) * 100);
    
    $('#collection-progress-text').text(`${ownedCount} / ${totalCount} ใบ (${percentage}%)`);
    $('#collection-progress-bar').css('width', `${percentage}%`);
}

// --- LOGIC: แก้ไข KYT ---

// 1. กดปุ่มแก้ไขในหน้า Monitor -> เปิด Modal
$(document).on('click', '.btn-edit-kyt', function() {
    const data = JSON.parse(decodeURIComponent($(this).attr('data-kyt')));
    
    $('#edit-kyt-history-id').val(data.id);
    $('#edit-kyt-userid').val(data.userId);
    $('#edit-kyt-user-name').text(data.name);
    
    // ⭐ เอาคำถามมาแปะ (ถ้าไม่มีให้ขึ้นว่าไม่พบ)
    $('#edit-kyt-question-display').text(data.question || "(ไม่พบข้อมูลคำถาม)");
    
    $('#edit-kyt-status').val(data.isCorrect ? "1" : "0");
    $('#edit-kyt-score').val(data.score);

    new bootstrap.Modal(document.getElementById('admin-edit-kyt-modal')).show();
});

// 2. กดบันทึก -> ยิง API
$('#admin-edit-kyt-form').on('submit', async function(e) {
    e.preventDefault();
    
    const payload = {
        historyId: $('#edit-kyt-history-id').val(),
        lineUserId: $('#edit-kyt-userid').val(),
        isCorrect: $('#edit-kyt-status').val() === "1",
        newScore: parseInt($('#edit-kyt-score').val()) || 0
    };

    try {
        await callApi('/api/admin/kyt/update-answer', payload, 'POST');
        
        Swal.fire('สำเร็จ', 'แก้ไขและแจ้งเตือนผู้ใช้แล้ว', 'success');
        bootstrap.Modal.getInstance(document.getElementById('admin-edit-kyt-modal'))?.hide();
        
        // รีโหลดหน้า Monitor ทันที
        // (ต้องมั่นใจว่าฟังก์ชัน loadKytMonitor เข้าถึงได้ หรือกด tab ใหม่)
        const btn = $('button[data-bs-target="#tab-kyt"]');
        if(btn.length) btn.trigger('click'); 

    } catch (err) {
        Swal.fire('Error', err.message, 'error');
    }
});

// ===============================================================
//  AUTO REFRESH SYSTEM (Real-time Polling)
// ===============================================================
setInterval(() => {
    // ทำงานเฉพาะเมื่อ User อยู่หน้า Game Page และไม่ได้เปิด Modal ค้างไว้
    if ($('#game-page').hasClass('active') && !$('.modal.show').length) {
        
        // เรียก API แบบเงียบๆ (ไม่ต้องโชว์ Loading spinner)
        callApi('/api/user/profile', { lineUserId: AppState.lineProfile.userId })
            .then(res => {
                if (res.registered) {
                    const user = res.user;
                    const oldCoins = AppState.currentUser ? AppState.currentUser.coinBalance : 0;
                    
                    // อัปเดตข้อมูลใน AppState
                    AppState.currentUser = user;

                    // ถ้าเหรียญเปลี่ยน ให้ทำตัวเลขวิ่ง
                    if (user.coinBalance !== oldCoins) {
                        animateCoinChange(user.coinBalance);
                    }
                    
                    // อัปเดต Streak (เผื่อข้ามวันแล้วไฟดับ)
                    $('#streak-display').text((user.currentStreak || 0) + " วัน");
                }
            })
            .catch(e => console.error("Auto-refresh failed", e));
    }
}, 5000); // ทำงานทุก 5 วินาที