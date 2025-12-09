// ===============================================================
//  APP CONFIGURATION
// ===============================================================
const API_BASE_URL = "https://shesafety-spot-appbackend.onrender.com";
const LIFF_ID = "2007053300-9xLKdwZp";
// ตัวแปร global ฝั่ง frontend
let adminSelectedUserId = null;   // เก็บ lineUserId ของ user ที่เปิด modal อยู่ตอนนี้

// Global variables
const AppState = {
    lineProfile: null,
    currentUser: null,
    allModals: {},
    reportsChart: null,
    leaderboard: { currentPage: 1, hasMore: true },
    // highlight-start
    adminUsers: { currentPage: 1, hasMore: true, currentSearch: '', currentSort: 'score' } // เพิ่ม currentSort
    // highlight-end
};

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
    initializeApp();
    bindStaticEventListeners();
    bindAdminTabEventListeners();
});

function initializeAllModals() {
    // highlight-start
    const modalIds = ['submission', 'admin-reports', 'admin-activities', 'activity-form', 'activity-detail', 'admin-stats', 'admin-manage-badges', 'badge-form', 'user-details', 'notification'];
    // highlight-end
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
        AppState.currentUser = userData;
        updateUserInfoUI(AppState.currentUser);
        
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

        displayActivitiesUI(activities, 'latest-activities-list');
        displayActivitiesUI(activities, 'all-activities-list');
        
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
function updateUserInfoUI(user) {
    $('#user-header').addClass('user-header-card');

    $('#user-profile-pic, #profile-page-pic').attr('src', user.pictureUrl || 'https://placehold.co/80x80');
    $('#user-display-name, #profile-page-name').text(user.fullName);
    $('#user-employee-id').text(`รหัส: ${user.employeeId}`);
    $('#profile-page-employee-id').text(`รหัสพนักงาน: ${user.employeeId}`);
    $('#user-score, #profile-page-score').text(user.totalScore);
}

// ในไฟล์ app.js
function displayActivitiesUI(activities, listId) {
    const listElement = $(`#${listId}`);
    listElement.empty();
    if (!activities || activities.length === 0) {
        listElement.html('<p class="text-center text-muted">ยังไม่มีกิจกรรมในขณะนี้</p>');
        return;
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

        const cardHtml = `
            <div class="card activity-card mb-3">
                 <img src="${getFullImageUrl(act.imageUrl, { w: 600 })}"
                        loading="lazy" decoding="async"
                        class="activity-card-img"
                        onerror="this.onerror=null;this.src='https://placehold.co/600x300/e9ecef/6c757d?text=Image';">
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

                    <p class="card-text submission-description mb-3 preserve-whitespace">
                        ${sanitizeHTML(sub.description)}
                    </p>

                    <div class="d-flex justify-content-between align-items-center pt-2 border-top">
                        <div class="d-flex align-items-center gap-3">
                            ${pointsBadge}
                            <a href="#" class="text-decoration-none like-btn ${likedClass}"
                               data-submission-id="${sub.submissionId}">
                                <i class="fas fa-heart"></i>
                                <span class="like-count">${sub.likes || 0}</span>
                            </a>
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
            plugins: {
                title: { display: true, text: 'จำนวนรายงาน 7 วันล่าสุด' }
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

            const itemHtml = `
                <div class="d-flex align-items-center p-2 mb-2 bg-white rounded-3 shadow-sm leaderboard-item">
                    <div class="leaderboard-rank me-3">${rankDisplay}</div>
                    <img src="${user.pictureUrl}" class="rounded-circle me-3" width="45" height="45" onerror="this.onerror=null;this.src='https://placehold.co/45x45';">
                    <div class="flex-grow-1"><div class="fw-bold">${sanitizeHTML(user.fullName)}</div></div>
                    <div class="fw-bold" style="color: var(--line-green);">${user.totalScore} คะแนน</div>
                </div>`;
            list.append(itemHtml);
        });

        if (users.length < 30) {
            // ถ้าข้อมูลที่ได้มาน้อยกว่า 30 แสดงว่าหมดแล้ว
            AppState.leaderboard.hasMore = false;
            $('#leaderboard-load-more-container').hide();
        } else {
            // ถ้ายังมีอีก ให้แสดงปุ่ม
            AppState.leaderboard.currentPage++;
            $('#leaderboard-load-more-container').show();
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
        const [userDataResponse, activities] = await Promise.all([
            callApi('/api/user/profile', { lineUserId: AppState.lineProfile.userId }),
            callApi('/api/activities', { lineUserId: AppState.lineProfile.userId })
        ]);

        if (userDataResponse.registered) {
            AppState.currentUser = userDataResponse.user;
            updateUserInfoUI(AppState.currentUser);
        }

        displayActivitiesUI(activities, 'latest-activities-list');

    } catch (error) {
        console.error("Failed to refresh home page data:", error);
        showError("ไม่สามารถรีเฟรชข้อมูลได้");
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

    $('#registration-form').on('submit', handleRegistration);
    $('#submission-form').on('submit', handleSubmitReport);
    $('#activity-form').on('submit', handleSaveActivity);
    $('#badge-form').on('submit', handleSaveBadge);

    $(document).on('click', '.btn-view-report', handleViewReport);
    $(document).on('click', '.btn-join-activity', handleJoinActivity);
    $(document).on('click', '.like-btn', handleLike);
    $(document).on('click', '.send-comment-button', handleComment);
    
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
    $('#add-card-btn').on('click', handleAddCard);
    $('#card-form').on('submit', handleSaveCard);
    $('#card-image-input').on('change', function() { handleImagePreview(this, '#card-image-preview'); $('#card-image-preview').show(); });

    // ปุ่ม Edit/Delete ในลิสต์การ์ด
    $(document).on('click', '.btn-edit-card', handleEditCard);
    $(document).on('click', '.btn-delete-card', handleDeleteCard);

    // Event สำหรับปุ่มในรายการคำถาม (Edit/Delete/Toggle)
    $(document).on('click', '.btn-edit-q', handleEditQuestion);
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
        // เรียกใช้ fetchAdminUsers โดยบอกว่าเป็น "Load More" (isLoadMore = true)
        fetchAdminUsers(AppState.adminUsers.currentPage, AppState.adminUsers.currentSearch, true);
    });

    // ---- เพิ่ม Event Listener สำหรับปุ่ม Sort ----
    $('#user-sort-options').on('click', '.btn-sort', function() {
        const btn = $(this);
        const sortBy = btn.data('sort');

        // ถ้ากดปุ่มที่ Active อยู่แล้ว ไม่ต้องทำอะไร
        if (btn.hasClass('active')) {
            return; 
        }

        // อัปเดต UI ของปุ่ม
        $('#user-sort-options .btn-sort').removeClass('active');
        btn.addClass('active');

        // อัปเดต state
        AppState.adminUsers.currentSort = sortBy;

        // เรียกข้อมูลใหม่ โดยเริ่มจากหน้า 1 เสมอเมื่อมีการเปลี่ยนการเรียงลำดับ
        const currentQuery = $('#user-search-input').val();
        fetchAdminUsers(1, currentQuery, false);
    });
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
    showLoading('กำลังบันทึก...');
    try {
        const newUser = await callApi("/api/user/register", { lineUserId: AppState.lineProfile.userId, displayName: AppState.lineProfile.displayName, pictureUrl: AppState.lineProfile.pictureUrl, fullName: fullName, employeeId: employeeId }, 'POST');
        $('#registration-page').hide();
        await showMainApp(newUser);
        showSuccess('ลงทะเบียนเรียบร้อย!');
    } catch (error) { showError(error.message); }
}

async function handleSubmitReport(e) {
    e.preventDefault();
    const imageFile = $('#image-input')[0].files[0];
    const description = $('#description-input').val().trim();
    if (!description) { return showWarning('กรุณากรอกรายละเอียดจุดเสี่ยง'); }
    showLoading('กำลังอัปโหลดและส่งรายงาน...');
    try {
        let imageUrl = null;
        if (imageFile) { imageUrl = await uploadImage(imageFile); }
        const payload = { lineUserId: AppState.lineProfile.userId, activityId: $('#activityId-input').val(), description: description, imageUrl: imageUrl };
        await callApi('/api/submissions', payload, 'POST');
        AppState.allModals.submission.hide();
        $('#submission-form')[0].reset();
        $('#submission-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
        showSuccess('รายงานของคุณถูกส่งเพื่อรอการตรวจสอบ');
        // --- ส่วนที่เพิ่มเข้ามา ---
        // หาปุ่มของกิจกรรมที่เราเพิ่งส่งไป แล้วเปลี่ยนสถานะมัน
        const activityId = $('#activityId-input').val();
        const activityButton = $(`.btn-join-activity[data-activity-id="${activityId}"]`);
        if (activityButton.length > 0) {
            activityButton
                .prop('disabled', true)
                .removeClass('btn-primary')
                .addClass('btn-success')
                .html('<i class="fas fa-check-circle me-1"></i> เข้าร่วมแล้ว');
        }
        // --- จบส่วนที่เพิ่มเข้ามา ---

    } catch (error) { showError(error.message); }
}

function handleViewReport() {
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');
    loadAndShowActivityDetails(activityId, activityTitle);
}

function handleJoinActivity() {
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');

    const isImageRequired = $(this).data('image-required');
    const imageUploadSection = $('#image-upload-section');
    const imageInput = $('#image-input');

    if (isImageRequired) {
        imageUploadSection.show(); // แสดงส่วนอัปโหลด
        imageInput.prop('required', true); // ตั้งให้ "ต้องมี" ไฟล์
    } else {
        imageUploadSection.hide(); // ซ่อนส่วนอัปโหลด
        imageInput.prop('required', false); // ตั้งให้ "ไม่จำเป็นต้องมี" ไฟล์
    }

    $('#activityId-input').val(activityId);
    $('#activity-title-modal').text(activityTitle);
    AppState.allModals['submission'].show();
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

// --- Admin Handlers ---
async function handleViewStats() { await loadAdminStats(); AppState.allModals['admin-stats'].show(); }
async function handleManageReports() { await loadPendingSubmissions(); AppState.allModals['admin-reports'].show(); }
async function handleManageActivities() { await loadAllActivitiesForAdmin(); AppState.allModals['admin-activities'].show(); }
function handleCreateActivity() {
    $('#activity-form-title').text('สร้างกิจกรรมใหม่');
    $('#activity-form')[0].reset();
    $('#form-activity-id').val('');
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
    const existingImageUrl = $('#form-activity-image-url').val();
    
    try {
        let finalImageUrl = existingImageUrl;
        if (imageFile) {
            finalImageUrl = await uploadImage(imageFile);
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
    $('#activity-image-preview').attr('src', getFullImageUrl(data.imageUrl));
    AppState.allModals['activity-form'].show();
}
async function handleToggleActivity() {
    const btn = $(this);
    const id = btn.data('id');
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

    // ⭐ ตั้งค่าผู้ใช้ที่เลือกไว้สำหรับปรับคะแนน
    adminSelectedUserId = lineUserId;

    $("#admin-score-box").hide(); // ซ่อนไว้ก่อน

    $('#user-details-badges-container').html(
        '<div class="text-center"><div class="spinner-border"></div></div>'
    );
    modal.show();

    try {
        // 1) โหลดข้อมูล user + badges
        const userData = await callApi('/api/admin/user-details', { lineUserId });
        const user = userData.user;
        const earnedBadges = Array.isArray(userData.badges) ? userData.badges : [];

        // 2) โหลด badge ทั้งหมด
        const allBadges = await callApi('/api/admin/badges');

        // 3) แสดงข้อมูลผู้ใช้
        $("#detailUserName").text(user.fullName);
        $("#detailUserEmployeeId").text(user.employeeId);
        $("#detailUserScore").text(user.totalScore);
        $("#detailUserPicture").attr("src", user.pictureUrl || "https://placehold.co/60x60");

        // ⭐⭐ แสดง admin-score-box เฉพาะแอดมิน ⭐⭐
        if (AppState.currentUser && AppState.currentUser.isAdmin) {
            $("#admin-score-box").show();
            $("#adminUserCurrentScore").text(user.totalScore);
        }

        // 4) แสดง badge
        const badgesContainer = $('#user-details-badges-container');
        badgesContainer.empty();

        const earnedIds = new Set(earnedBadges.map(b => b.badgeId));

        const badgesHtml = allBadges.map(badge => {
            const isEarned = earnedIds.has(badge.badgeId);
            return `
                <div class="d-flex justify-content-between align-items-center p-2 border-bottom">
                    <span>${sanitizeHTML(badge.badgeName)}</span>
                    <button class="btn btn-sm ${isEarned ? 'btn-outline-danger' : 'btn-success'} badge-toggle-btn"
                            data-userid="${lineUserId}"
                            data-badgeid="${badge.badgeId}"
                            data-action="${isEarned ? 'revoke' : 'award'}">
                        <i class="fas ${isEarned ? 'fa-times' : 'fa-check'} me-1"></i>
                        ${isEarned ? 'เพิกถอน' : 'มอบรางวัล'}
                    </button>
                </div>`;
        }).join('');

        badgesContainer.html(badgesHtml);

    } catch (e) {
        console.error('handleViewUserDetails error:', e);
        showError(e.message || 'ไม่สามารถโหลดข้อมูลได้');
        $('#user-details-badges-container').html('<p class="text-danger">ไม่สามารถโหลดข้อมูลได้</p>');
    }
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

// =====================================================
// โหลดข้อมูล user + badge + score สำหรับหน้า Admin
// =====================================================
async function loadAdminUserDetails(lineUserId) {

    try {
        const detail = await callApi('/api/admin/user-details', {
            lineUserId
        });

        const user = detail.user;
        const earnedBadges = Array.isArray(detail.badges) ? detail.badges : [];

        // อัปเดต UI: ข้อมูลผู้ใช้
        $("#detailUserName").text(user.fullName);
        $("#detailUserEmployeeId").text(user.employeeId);
        $("#detailUserScore").text(user.totalScore);
        $("#detailUserPicture").attr("src", user.pictureUrl || "https://placehold.co/80x80");

        // อัปเดต UI: กล่องปรับคะแนน
        $("#adminUserCurrentScore").text(user.totalScore);

        // อัปเดต badge list
        const badgesContainer = $('#user-details-badges-container');
        badgesContainer.html('<div class="spinner-border"></div>');

        const allBadges = await callApi('/api/admin/badges');
        badgesContainer.empty();

        const earnedIds = new Set(earnedBadges.map(b => b.badgeId));

        allBadges.forEach(badge => {
            const isEarned = earnedIds.has(badge.badgeId);

            const row = `
                <div class="d-flex justify-content-between align-items-center p-2 border-bottom">
                    <span>${sanitizeHTML(badge.badgeName)}</span>
                    <button class="btn btn-sm ${isEarned ? 'btn-outline-danger' : 'btn-success'} badge-toggle-btn"
                        data-userid="${lineUserId}"
                        data-badgeid="${badge.badgeId}"
                        data-action="${isEarned ? 'revoke' : 'award'}">
                        <i class="fas ${isEarned ? 'fa-times' : 'fa-check'} me-1"></i>
                        ${isEarned ? 'เพิกถอน' : 'มอบรางวัล'}
                    </button>
                </div>
            `;
            badgesContainer.append(row);
        });

    } catch (err) {
        console.error("loadAdminUserDetails failed:", err);
        showError("โหลดข้อมูลผู้ใช้ไม่สำเร็จ");
    }
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
        } else {
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
                                    <h6 class="card-title fw-bold">${sanitizeHTML(s.fullName)}</h6>
                                    <p class="card-text small">${sanitizeHTML(s.description)}</p>
                                    <p class="card-text"><small class="text-muted">${new Date(s.createdAt).toLocaleString('th-TH')}</small></p>
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
async function loadBadgesForAdmin() {
    const list = $('#badges-list');
    list.html('<div class="text-center my-4"><div class="spinner-border text-success"></div><p class="text-muted mt-2">กำลังโหลดป้ายรางวัล...</p></div>');
    try {
        const badges = await callApi('/api/admin/badges');
        list.empty();
        if (badges.length === 0) {
            list.html('<p class="text-center text-muted my-4">ยังไม่มีป้ายรางวัลในระบบ</p>');
        } else {
            badges.forEach(b => {
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
            }
            AppState.adminUsers.hasMore = false;
            return;
        }

        // 2) ดึง badge ของแต่ละคนจาก /api/admin/user-details แล้วนับจำนวนป้าย
        const usersWithBadgeCounts = await Promise.all(
            users.map(async (u) => {
                try {
                    const detail = await callApi('/api/admin/user-details', {
                        lineUserId: u.lineUserId
                    });
                    const badgesArr = Array.isArray(detail.badges) ? detail.badges : [];
                    const badgeCount = badgesArr.length;

                    // รวมค่าเดิม + badgeCount ใหม่เข้าไป
                    return {
                        ...u,
                        badgeCount
                    };
                } catch (err) {
                    console.error('โหลดจำนวนป้ายของผู้ใช้ไม่สำเร็จ', u.lineUserId, err);
                    return {
                        ...u,
                        badgeCount: 0
                    };
                }
            })
        );

        // 3) แสดงผลใน list (ตอนนี้แต่ละ user จะมี field badgeCount แน่นอนแล้ว)
        renderUserListForAdmin(usersWithBadgeCounts, resultsContainer);

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


function renderUserListForAdmin(users, container) {
    users.forEach(user => {
        // พยายามดึงจำนวนป้ายจากหลาย ๆ ฟิลด์ เผื่อ backend ใช้ชื่อไม่ตรงกัน
        const badgeCount =
            typeof user.badgeCount === 'number' ? user.badgeCount :
            typeof user.badgesCount === 'number' ? user.badgesCount :
            Array.isArray(user.badges) ? user.badges.length : 0;

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
                        <i class="fas fa-chevron-right ms-auto text-muted"></i>
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

    if (!delta || delta <= 0) {
        return Swal.fire("กรุณากรอกจำนวนคะแนนให้ถูกต้อง", "", "warning");
    }

    const deltaScore = mode === "sub" ? -Math.abs(delta) : Math.abs(delta);

    // UI Loading
    const applyBtnText = $("#adminScoreBtnText");
    const loadingIcon = $("#adminScoreBtnLoading");
    applyBtnText.addClass("d-none");
    loadingIcon.removeClass("d-none");

    try {
        // callApi() คืนค่าเฉพาะ result.data → ไม่มี result.status
        const result = await callApi('/api/admin/users/update-score', {
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

// ปุ่มกากบาทปิดกล่องจัดการคะแนน (ซ่อนเฉพาะกล่องนี้ ไม่ได้ปิด modal ทั้งหมด)
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
            $('#option-a').text(q.options.A); $('#option-b').text(q.options.B);
            $('#option-c').text(q.options.C); $('#option-d').text(q.options.D);
            $('#option-e').text(q.options.E); $('#option-f').text(q.options.F);
            $('#option-g').text(q.options.G); $('#option-h').text(q.options.H);
            
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

// --- แก้ไข Event Listener ตอบคำถามใน app.js ---
$(document).on('click', '.answer-btn', async function() {
    const btn = $(this);
    const choice = btn.data('choice');
    const qid = $('#game-content').data('qid');

    $('.answer-btn').prop('disabled', true); // ล็อกปุ่ม

    try {
        const res = await callApi('/api/game/submit-answer', {
            lineUserId: AppState.lineProfile.userId,
            questionId: qid,
            selectedOption: choice
        }, 'POST');

        // ==========================================
        // 1. อัปเดตเหรียญที่หน้าจอทันที (สำคัญ!)
        // ==========================================
        $('#coin-display').text(res.newCoinBalance);
        
        // อัปเดตในตัวแปร Global ด้วย เผื่อไปหน้าอื่น
        if(AppState.currentUser) {
            AppState.currentUser.coinBalance = res.newCoinBalance;
            AppState.currentUser.totalScore = res.newTotalScore;
        }
        // ==========================================

        if (res.isCorrect) {
            // --- กรณีตอบถูก ---
            btn.addClass('correct');
            Swal.fire({
                icon: 'success',
                title: 'ถูกต้อง! เก่งมาก',
                html: `คุณได้รับ <b class="text-warning">${res.earnedCoins} เหรียญ</b> 💰`,
                confirmButtonText: 'เยี่ยมเลย',
                confirmButtonColor: '#06C755'
            });
        } else {
            // --- กรณีตอบผิด ---
            btn.addClass('wrong');
            // เฉลยข้อถูกให้ดูด้วย
            $(`.answer-btn[data-choice="${res.correctOption}"]`).addClass('correct');
            
            Swal.fire({
                icon: 'error',
                title: 'ยังไม่ถูกนะ...',
                // แจ้งว่าได้รางวัลปลอบใจ
                html: `ข้อที่ถูกคือ <b>${res.correctOption}</b><br>แต่ไม่ต้องเสียใจ รับรางวัลปลอบใจไป <b class="text-warning">${res.earnedCoins} เหรียญ</b> 💰`,
                confirmButtonText: 'ไปต่อ',
                confirmButtonColor: '#6c757d'
            });
        }

        // รีเฟรชหน้าเกมเพื่อเปลี่ยนสถานะเป็น "เล่นจบแล้ว"
        setTimeout(() => {
            $('#quiz-modal').modal('hide'); // ปิด Modal
            loadGameDashboard(); // โหลดหน้า Dashboard ใหม่ (Streak/Coin จะไม่อัปเดตถ้าไม่เรียกอันนี้)
        }, 2500);

    } catch (e) {
        Swal.fire('แจ้งเตือน', e.message, 'warning');
        $('.answer-btn').prop('disabled', false); // ปลดล็อกปุ่มถ้า Error
    }
});

// --- ADMIN: QUESTION MANAGEMENT ---

async function handleManageQuestions() {
    const list = $('#questions-list-admin');
    list.html('<div class="col-12 text-center my-5"><div class="spinner-border text-success"></div></div>');
    AppState.allModals['admin-questions'] = new bootstrap.Modal(document.getElementById('admin-questions-modal'));
    AppState.allModals['admin-questions'].show();

    try {
        const questions = await callApi('/api/admin/questions');
        list.empty();

        if (questions.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีคำถามในระบบ</div>');
            return;
        }

        questions.forEach(q => {
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
                            <div>
                                <h6 class="fw-bold mb-1 text-dark">${sanitizeHTML(q.questionText)}</h6>
                                <p class="mb-0 small text-muted">
                                    <span class="${q.correctOption === 'A' ? 'text-success fw-bold' : ''}">A: ${sanitizeHTML(q.optionA)}</span><br>
                                    <span class="${q.correctOption === 'B' ? 'text-success fw-bold' : ''}">B: ${sanitizeHTML(q.optionB)}</span>
                                </p>
                            </div>
                        </div>
                        
                        <div class="mt-3 d-flex gap-2 justify-content-end">
                            <button class="btn btn-sm ${statusBtnClass} btn-toggle-q" data-id="${q.questionId}">
                                ${statusBtnText}
                            </button>
                            <button class="btn btn-sm btn-primary btn-edit-q" data-q='${qData}'>
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-danger btn-delete-q" data-id="${q.questionId}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>`;
            list.append(html);
        });

    } catch (e) {
        list.html(`<div class="col-12 text-center text-danger">เกิดข้อผิดพลาด: ${e.message}</div>`);
    }
}

function handleAddQuestion() {
    $('#question-form-title').text('เพิ่มคำถามใหม่');
    $('#question-form')[0].reset();
    $('#q-id').val('');
    $('#q-image-preview').hide().attr('src', '');
    $('#q-image-url').val('');
    
    AppState.allModals['question-form'] = new bootstrap.Modal(document.getElementById('question-form-modal'));
    AppState.allModals['question-form'].show();
}

function handleEditQuestion() {
    const data = JSON.parse(decodeURIComponent($(this).data('q')));
    
    $('#question-form-title').text('แก้ไขคำถาม');
    $('#q-id').val(data.questionId);
    $('#q-text').val(data.questionText);
    $('#q-opt-a').val(data.optionA); $('#q-opt-b').val(data.optionB);
    $('#q-opt-c').val(data.optionC); $('#q-opt-d').val(data.optionD);
    $('#q-opt-e').val(data.optionE); $('#q-opt-f').val(data.optionF);
    $('#q-opt-g').val(data.optionG); $('#q-opt-h').val(data.optionH);
    $(`input[name="correctOption"][value="${data.correctOption}"]`).prop('checked', true);
    $('#q-score').val(data.scoreReward);
    
    $('#q-image-url').val(data.imageUrl || '');
    if (data.imageUrl) {
        $('#q-image-preview').attr('src', getFullImageUrl(data.imageUrl)).show();
    } else {
        $('#q-image-preview').hide();
    }

    AppState.allModals['question-form'] = new bootstrap.Modal(document.getElementById('question-form-modal'));
    AppState.allModals['question-form'].show();
}

async function handleSaveQuestion(e) {
    e.preventDefault();
    const btn = $(this).find('button[type="submit"]');
    btn.prop('disabled', true).text('กำลังบันทึก...');

    try {
        // Handle Image Upload
        const fileInput = $('#q-image-input')[0];
        let finalImageUrl = $('#q-image-url').val();

        if (fileInput.files.length > 0) {
            finalImageUrl = await uploadImage(fileInput.files[0]);
        }

        const payload = {
            questionId: $('#q-id').val(),
            questionText: $('#q-text').val(),
            optionA: $('#q-opt-a').val(), optionB: $('#q-opt-b').val(),
            optionC: $('#q-opt-c').val(), optionD: $('#q-opt-d').val(),
            optionE: $('#q-opt-e').val(), optionF: $('#q-opt-f').val(),
            optionG: $('#q-opt-g').val(), optionH: $('#q-opt-h').val(),
            correctOption: $('input[name="correctOption"]:checked').val(),
            scoreReward: $('#q-score').val(),
            imageUrl: finalImageUrl
        };

        await callApi('/api/admin/questions', payload, 'POST');
        
        AppState.allModals['question-form'].hide();
        showSuccess('บันทึกข้อมูลเรียบร้อย');
        handleManageQuestions(); // Refresh list

    } catch (e) {
        showError(e.message);
    } finally {
        btn.prop('disabled', false).text('บันทึกข้อมูล');
    }
}

async function handleToggleQuestion() {
    const btn = $(this);
    btn.prop('disabled', true);
    try {
        await callApi('/api/admin/questions/toggle', { questionId: btn.data('id') }, 'POST');
        handleManageQuestions(); // Refresh UI
    } catch (e) {
        showError('ไม่สามารถเปลี่ยนสถานะได้');
        btn.prop('disabled', false);
    }
}

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
            handleManageQuestions();
        } catch (e) {
            showError(e.message);
        }
    }
}

// ===============================================================
//  GAME DASHBOARD & GACHA LOGIC (NEW V.2)
// ===============================================================

// 1. โหลดข้อมูล Dashboard หน้าเกม (Coin & Streak)
async function loadGameDashboard() {
    console.log("Loading Game Dashboard...");
    
    // โหลดจำนวนเหรียญ (ถ้าใน User Profile ยังไม่มี field coin ให้ใช้คะแนนแทนไปก่อน หรือแก้ Backend)
    // สมมติว่า Backend ส่ง coinBalance มากับ profile แล้ว
    const user = AppState.currentUser; 
    
    // *หมายเหตุ: ถ้า Backend ยังไม่แก้ ให้ใช้ Dummy data ไปก่อนเพื่อดูผลลัพธ์ UI
    const coins = user.coinBalance !== undefined ? user.coinBalance : 0; 
    const streak = user.currentStreak !== undefined ? user.currentStreak : 0;

    $('#coin-display').text(coins);
    $('#streak-display').text(streak + " วัน");

    // โหลด Mini Collection (การ์ด 5 ใบล่าสุด)
    try {
        const badges = await callApi('/api/user/badges', { lineUserId: AppState.lineProfile.userId });
        const recentBadges = badges.filter(b => b.isEarned).slice(0, 5); // เอา 5 ใบแรกที่ได้
        
        const list = $('#mini-collection-list');
        list.empty();
        
        if(recentBadges.length === 0) {
            list.html('<div class="text-muted small p-2">ยังไม่มีการ์ด</div>');
        } else {
            recentBadges.forEach(b => {
                list.append(`
                    <img src="${getFullImageUrl(b.img)}" class="rounded border bg-white" 
                         style="width: 50px; height: 50px; object-fit: cover;" 
                         data-bs-toggle="tooltip" title="${b.name}">
                `);
            });
        }
    } catch (e) {
        console.error("Load mini collection error:", e);
    }
}

// 2. ฟังก์ชันเริ่ม Quiz (ผูกกับปุ่ม "เริ่มเล่นเลย")
function startDailyQuiz() {
    // เปิด Modal Quiz
    const quizModal = new bootstrap.Modal(document.getElementById('quiz-modal'));
    quizModal.show();
    
    // โหลดคำถาม (ใช้ฟังก์ชันเดิมที่มีอยู่แล้ว)
    loadGamePage(); 
}

// 3. ฟังก์ชันหมุนกาชา (ผูกกับปุ่ม "หมุนตู้เลย")
async function pullGacha() {
    // เช็คเหรียญก่อน (Client side check)
    const currentCoins = parseInt($('#coin-display').text()) || 0;
    if(currentCoins < 100) {
        return Swal.fire({
            icon: 'warning',
            title: 'เหรียญไม่พอ',
            text: 'ต้องการ 100 เหรียญเพื่อหมุนตู้\nไปทำภารกิจตอบคำถามก่อนนะ!',
            confirmButtonText: 'โอเค'
        });
    }

    // Animation หมุนตู้
    Swal.fire({
        title: 'กำลังสุ่ม...',
        html: '<div class="my-3"><i class="fas fa-sync fa-spin fa-3x text-warning"></i></div><p>ขอให้โชคดี!</p>',
        showConfirmButton: false,
        allowOutsideClick: false
    });

    try {
        // เรียก API Gacha (ต้องมี Backend รองรับตามที่คุยกันรอบที่แล้ว)
        // *ถ้ายังไม่ได้ทำ Backend ส่วน gacha-pull ให้ใช้บรรทัดล่างนี้แทนเพื่อทดสอบ UI*
        // const res = { remainingCoins: currentCoins - 100, badge: { badgeName: 'Test Badge', imageUrl: '' } }; await new Promise(r => setTimeout(r, 1500)); 
        
        const res = await callApi('/api/game/gacha-pull', { lineUserId: AppState.lineProfile.userId }, 'POST');
        
        // Update UI
        $('#coin-display').text(res.remainingCoins);
        if(AppState.currentUser) AppState.currentUser.coinBalance = res.remainingCoins;

        // Show Reward
        Swal.fire({
            title: '✨ ยินดีด้วย! ✨',
            html: `คุณได้รับ <b>${res.badge.badgeName}</b>`,
            imageUrl: getFullImageUrl(res.badge.imageUrl),
            imageWidth: 150,
            imageAlt: 'Reward',
            confirmButtonText: 'เก็บใส่สมุด',
            confirmButtonColor: '#06C755'
        }).then(() => {
            // โหลด Mini Collection ใหม่
            loadGameDashboard();
        });

    } catch (e) {
        Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
    }
}

// --- CARD ALBUM LOGIC ---

async function openCardAlbum() {
    const modal = new bootstrap.Modal(document.getElementById('card-album-modal'));
    modal.show();
    
    const container = $('#album-grid');
    container.html('<div class="col-12 text-center py-5"><div class="spinner-border text-primary"></div></div>');

    try {
        const res = await callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId });
        const cards = res; // API คืนค่าเป็น Array ใน data

        container.empty();
        
        let ownedCount = 0;
        cards.forEach(c => {
            if (c.isOwned) ownedCount++;
            
            // กำหนดสีตาม Rarity
            let borderColor = '#dee2e6'; // Common
            let bgBadge = 'bg-secondary';
            if (c.rarity === 'R') { borderColor = '#0dcaf0'; bgBadge = 'bg-info'; }
            if (c.rarity === 'SR') { borderColor = '#d63384'; bgBadge = 'bg-danger'; }
            if (c.rarity === 'UR') { borderColor = '#ffc107'; bgBadge = 'bg-warning text-dark'; }

            // Effect การ์ดที่ยังไม่มี (Greyscale)
            const imgFilter = c.isOwned ? '' : 'filter: grayscale(100%); opacity: 0.5;';
            const countBadge = c.count > 1 ? `<span class="position-absolute top-0 end-0 translate-middle badge rounded-pill bg-danger border border-white">+${c.count}</span>` : '';

            const html = `
                <div class="col-4 col-sm-3 mb-2">
                    <div class="card h-100 border-0 shadow-sm position-relative" style="overflow: visible;">
                        ${countBadge}
                        <div class="card-body p-2 text-center d-flex flex-column align-items-center">
                            <div class="rounded-3 mb-2 d-flex align-items-center justify-content-center" 
                                 style="width: 100%; aspect-ratio: 1/1; border: 2px solid ${borderColor}; background: #fff; overflow: hidden;">
                                <img src="${getFullImageUrl(c.imageUrl)}" class="img-fluid" style="${imgFilter}" onerror="this.src='https://placehold.co/100?text=?'">
                            </div>
                            <span class="badge ${bgBadge} mb-1" style="font-size: 0.6rem;">${c.rarity}</span>
                            <small class="d-block text-truncate w-100 fw-bold" style="font-size: 0.7rem;">${c.cardName}</small>
                        </div>
                    </div>
                </div>
            `;
            container.append(html);
        });

        // Update Progress
        const progress = Math.round((ownedCount / cards.length) * 100);
        $('#album-progress-text').text(`${ownedCount}/${cards.length}`);
        $('#album-progress-bar').css('width', `${progress}%`);

    } catch (e) {
        console.error(e);
        container.html('<p class="text-danger text-center">โหลดข้อมูลไม่สำเร็จ</p>');
    }
}

// อัปเดตฟังก์ชัน loadGameDashboard ให้ดึง Card แทน Badge
async function loadGameDashboard() {
    // ... (โค้ดเดิมส่วน Coin/Streak) ...
    const user = AppState.currentUser;
    $('#coin-display').text(user.coinBalance || 0);
    $('#streak-display').text((user.currentStreak || 0) + " วัน");

    // --- ส่วนที่แก้: ดึง Safety Cards แทน Badges ---
    try {
        // ใช้ API ใหม่ที่เราเพิ่งสร้าง
        const cards = await callApi('/api/user/cards', { lineUserId: AppState.lineProfile.userId });
        const recentCards = cards.filter(c => c.isOwned).slice(0, 5); // เอา 5 ใบแรก (หรือจะ sort by obtainedAt ถ้าทำได้)
        
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
        }
    } catch (e) { console.error(e); }
}

// --- ADMIN: CARD MANAGEMENT ---

async function handleManageCards() {
    const list = $('#cards-list-admin');
    list.html('<div class="col-12 text-center my-5"><div class="spinner-border text-success"></div></div>');
    const modal = new bootstrap.Modal(document.getElementById('admin-cards-modal'));
    modal.show();

    try {
        const cards = await callApi('/api/admin/cards');
        list.empty();

        if (cards.length === 0) {
            list.html('<div class="col-12 text-center text-muted mt-5">ยังไม่มีการ์ดในระบบ</div>');
            return;
        }

        cards.forEach(c => {
            // สี Badge ตาม Rarity
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
                            <button class="btn btn-sm btn-outline-primary btn-edit-card" data-card='${cardData}'>
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-danger btn-delete-card" data-id="${c.cardId}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>`;
            list.append(html);
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
        const mode = $('input[name="imgSource"]:checked').val();
        let finalImageUrl = $('#card-image-final-url').val(); // ค่าตั้งต้น = รูปเดิม

        if (mode === 'upload') {
            // โหมดอัปโหลด: ถ้ามีการเลือกไฟล์ใหม่ ให้อัปโหลด
            const fileInput = $('#card-image-input')[0];
            if (fileInput.files.length > 0) {
                finalImageUrl = await uploadImage(fileInput.files[0]);
            }
        } else {
            // โหมดลิงก์: ใช้ค่าจากช่อง Text
            const urlInput = $('#card-image-url-text').val().trim();
            if (urlInput) {
                finalImageUrl = urlInput;
            }
        }

        const payload = {
            cardId: $('#card-id').val(),
            cardName: $('#card-name').val(),
            description: $('#card-desc').val(),
            rarity: $('#card-rarity').val(),
            imageUrl: finalImageUrl
        };

        await callApi('/api/admin/cards', payload, 'POST');
        
        // ปิด Modal และ Refresh
        const modalEl = document.getElementById('card-form-modal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        modal.hide();

        showSuccess('บันทึกข้อมูลเรียบร้อย');
        
        // ปิด Modal List ตัวเก่าก่อน แล้วค่อยเปิดใหม่เพื่อรีเฟรช (ป้องกัน Backdrop ค้าง)
        const listModalEl = document.getElementById('admin-cards-modal');
        const listModal = bootstrap.Modal.getInstance(listModalEl);
        listModal.hide();
        
        setTimeout(() => handleManageCards(), 500);

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
            
            // Refresh List
            const listModalEl = document.getElementById('admin-cards-modal');
            const listModal = bootstrap.Modal.getInstance(listModalEl);
            listModal.hide();
            setTimeout(() => handleManageCards(), 500);

        } catch (e) {
            showError(e.message);
        }
    }
}

// --- EXCHANGE SYSTEM ---

async function exchangeCoinsToScore() {
    // 1. ดึงค่าเหรียญปัจจุบันจากหน้าจอมาเช็คเบื้องต้น
    const currentCoins = parseInt($('#coin-display').text()) || 0;
    
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
        // Loading
        Swal.fire({
            title: 'กำลังแลกเปลี่ยน...',
            timerProgressBar: true,
            didOpen: () => { Swal.showLoading() }
        });

        try {
            // 3. ยิง API
            const res = await callApi('/api/game/exchange-coins', { lineUserId: AppState.lineProfile.userId }, 'POST');
            
            // 4. อัปเดต UI ทันที
            $('#coin-display').text(res.remainingCoins);
            // ถ้าหน้า Profile เปิดอยู่ หรือมีการเก็บตัวแปร Global
            if(AppState.currentUser) {
                AppState.currentUser.coinBalance = res.remainingCoins;
                AppState.currentUser.totalScore = res.newTotalScore;
            }
            
            // อัปเดตคะแนนที่ Header หน้า Home (ถ้ามี Element Id นี้)
            $('#user-score').text(res.newTotalScore);
            $('#profile-page-score').text(res.newTotalScore);

            // 5. Success Message
            Swal.fire({
                icon: 'success',
                title: 'แลกสำเร็จ!',
                html: `ยอดคงเหลือ: <b>${res.remainingCoins} เหรียญ</b><br>คะแนนสะสมใหม่: <b class="text-success">${res.newTotalScore} คะแนน</b>`,
                timer: 2000,
                showConfirmButton: false
            });

        } catch (e) {
            Swal.fire('เกิดข้อผิดพลาด', e.message, 'error');
        }
    }
}