// ===============================================================
//  APP CONFIGURATION
// ===============================================================
const API_BASE_URL = "https://shesafety-spot-appbackend.onrender.com";
const LIFF_ID = "2007053300-9xLKdwZp";

// Global variables
const AppState = {
    lineProfile: null,
    currentUser: null,
    allModals: {},
    reportsChart: null,
    // --- เพิ่ม 2 บรรทัดนี้ ---
    leaderboard: { currentPage: 1, hasMore: true },
    adminUsers: { currentPage: 1, hasMore: true, currentSearch: '' }
    // -------------------------
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
    const modalIds = ['submission', 'admin-reports', 'admin-activities', 'activity-form', 'activity-detail', 'admin-stats', 'admin-manage-badges', 'badge-form', 'user-details'];
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
        $('#loading-sub-text').text('เริ่มต้นการทำงานของ LIFF...');
        await liff.init({ liffId: LIFF_ID });

        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }

        $('#loading-status-text').text('กำลังดึงข้อมูลโปรไฟล์');
        $('#loading-sub-text').text('กรุณารอสักครู่...');
        const lineProfile = await liff.getProfile();
        AppState.lineProfile = lineProfile;
        
        $('#loading-status-text').text('กำลังตรวจสอบการลงทะเบียน');
        $('#loading-sub-text').text('เชื่อมต่อกับเซิร์ฟเวอร์ Safety Spot...');
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
        
        if (userData && userData.isAdmin) {
            $('#admin-nav-item').show();
            bindAdminEventListeners();
        }

        const activities = await callApi('/api/activities', { lineUserId: AppState.lineProfile.userId });
        displayActivitiesUI(activities, 'latest-activities-list');
        displayActivitiesUI(activities, 'all-activities-list');
        
        $('#main-app').fadeIn();
        // ===== START: เพิ่มโค้ดเรียกใช้ Pull to Refresh ตรงนี้ =====
        PullToRefresh.init({
            mainElement: 'body', // Element หลักที่อนุญาตให้ดึง
            onRefresh: async function(done) { // ฟังก์ชันที่จะทำงานเมื่อผู้ใช้ปล่อยนิ้ว
                await refreshHomePageData(); // เรียกใช้ฟังก์ชันรีเฟรชที่เราสร้างไว้
                done(); // บอก Library ว่ารีเฟรชเสร็จแล้ว (Spinner จะหายไป)
            },
            // ตั้งค่าไอคอนให้เข้ากับแอป (ใช้ Font Awesome)
            iconArrow: '<i class="fas fa-arrow-down"></i>',
            iconRefreshing: '<div class="spinner-border spinner-border-sm text-success" role="status"></div>',
            distThreshold: 80, // ระยะที่ต้องดึงลงมา (pixel)
            distMax: 100
        });
        // ===== END: เพิ่มโค้ดเรียกใช้ Pull to Refresh =====

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

async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file);
    try {
        const response = await fetch(`${API_BASE_URL}/api/upload`, {
            method: 'POST',
            body: formData,
        });
         if (!response.ok) {
            const errorResult = await response.json().catch(() => ({ message: 'Image upload failed with status ' + response.status }));
            throw new Error(errorResult.message);
        }
        const result = await response.json();
        if (result.status === 'success') {
            return result.data.imageUrl;
        } else {
            throw new Error(result.message || 'Failed to get image URL from server.');
        }
    } catch (error) {
        console.error('Image Upload Error:', error);
        throw new Error('อัปโหลดรูปภาพไม่สำเร็จ');
    }
}

// ===============================================================
//  UI RENDERING FUNCTIONS
// ===============================================================
function getFullImageUrl(path) {
    const placeholder = 'https://placehold.co/600x400/e9ecef/6c757d?text=Image';
    if (!path) { return placeholder; }
    if (path.startsWith('http://') || path.startsWith('https://')) { return path; }
    return `${API_BASE_URL}/uploads/${path}`;
}

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
                <img src="${getFullImageUrl(act.imageUrl)}" class="activity-card-img" onerror="this.onerror=null;this.src='https://placehold.co/600x300/e9ecef/6c757d?text=Image';">
                <div class="card-body">
                    <h5 class="card-title">${sanitizeHTML(act.title)}</h5>
                    <p class="card-text text-muted small">${sanitizeHTML(act.description.replace('[no-image]', ''))}</p>
                    <div class="d-flex justify-content-end align-items-center gap-2 mt-3">
                        <button class="btn btn-sm btn-outline-secondary btn-view-activity-image" 
                                data-image-full-url="${getFullImageUrl(act.imageUrl)}" 
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
    if (submissions.length === 0) { 
        container.html('<p class="text-center text-muted mt-5">ยังไม่มีใครส่งรายงานสำหรับกิจกรรมนี้<br>มาเป็นคนแรกกันเถอะ!</p>'); 
        return; 
    }
    submissions.forEach(sub => {
        const likedClass = sub.didLike ? 'liked' : '';
        const imageHtml = sub.imageUrl ? `
            <img src="${sub.imageUrl}" class="card-img-top submission-image" alt="Submission Image">
        ` : '';

        let commentsHtml = sub.comments.map(c => `
            <div class="d-flex mb-2">
                <img src="${c.commenter.pictureUrl || 'https://placehold.co/32x32'}" class="rounded-circle me-2 comment-profile-pic" width="32" height="32" alt="Profile">
                <div>
                    <small class="fw-bold d-block">${sanitizeHTML(c.commenter.fullName)}</small>
                    <small class="text-muted">${sanitizeHTML(c.commentText)}</small>
                </div>
            </div>`).join('');
        if (commentsHtml === '') {
            commentsHtml = '<small class="text-muted">ยังไม่มีความคิดเห็น</small>';
        }
        
        const card = `
            <div class="card shadow-sm mb-3 submission-card">
                ${imageHtml}
                <div class="card-body p-3">
                    <div class="d-flex align-items-center mb-3">
                        <img src="${sub.submitter.pictureUrl || 'https://placehold.co/45x45'}" class="rounded-circle me-3 profile-pic" alt="Profile Picture">
                        <div>
                            <h6 class="mb-0 submission-submitter">${sanitizeHTML(sub.submitter.fullName)}</h6>
                            <small class="text-muted">${new Date(sub.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</small>
                        </div>
                    </div>
                    <p class="card-text submission-description mb-3">${sanitizeHTML(sub.description)}</p>
                    
                    <div class="d-flex justify-content-between align-items-center pt-2 border-top">
                        <div class="d-flex align-items-center gap-3">
                             ${sub.points > 0 ? `<span class="badge points-badge"><i class="fas fa-star me-1"></i> ${sub.points} คะแนน</span>` : ''}
                             <a href="#" class="text-decoration-none like-btn ${likedClass}" data-submission-id="${sub.submissionId}">
                                <i class="fas fa-heart"></i> <span class="like-count">${sub.likes}</span>
                             </a>
                             <a href="#" class="text-decoration-none comment-btn" data-bs-toggle="collapse" data-bs-target="#comments-${sub.submissionId}">
                                <i class="fas fa-comment"></i> ${sub.comments.length}
                             </a>
                             
                             ${sub.imageUrl ? `
                             <a href="#" class="text-decoration-none view-image-btn" data-image-full-url="${sub.imageUrl}">
                                <i class="fas fa-search-plus"></i> ดูรูปภาพ
                             </a>
                             ` : ''}
                        </div>
                        ${AppState.currentUser.isAdmin ? `<button class="btn btn-sm btn-outline-danger btn-delete-submission" data-id="${sub.submissionId}"><i class="fas fa-trash-alt"></i></button>` : ''}
                    </div>

                    <div class="collapse mt-3" id="comments-${sub.submissionId}">
                        <div class="comment-section p-3">
                            <div class="comment-list mb-3">${commentsHtml}</div>
                            <div class="input-group">
                                <input type="text" class="form-control form-control-sm comment-input" placeholder="แสดงความคิดเห็น...">
                                <button class="btn btn-sm send-comment-button" type="button" data-submission-id="${sub.submissionId}">ส่ง</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
        container.append(card);
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
async function loadAndShowActivityDetails(activityId, activityTitle) {
    const modal = $('#activity-detail-modal');
    modal.data('current-activity-id', activityId);
    $('#activity-detail-title').text(activityTitle);
    
    const container = $('#submissions-container');
    $('#submissions-loading').show();
    container.empty();
    AppState.allModals['activity-detail'].show();
    try {
        const submissions = await callApi('/api/submissions', { activityId, lineUserId: AppState.lineProfile.userId });
        renderSubmissions(submissions);
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
        // ดึงข้อมูลผู้ใช้ (เพื่ออัปเดตคะแนน) และข้อมูลกิจกรรมพร้อมกัน
        const [userDataResponse, activities] = await Promise.all([
            callApi('/api/user/profile', { lineUserId: AppState.lineProfile.userId }),
            callApi('/api/activities')
        ]);

        // อัปเดตข้อมูลผู้ใช้และคะแนนบน UI
        if (userDataResponse.registered) {
            AppState.currentUser = userDataResponse.user;
            updateUserInfoUI(AppState.currentUser);
        }

        // อัปเดตลิสต์กิจกรรมล่าสุด
        displayActivitiesUI(activities, 'latest-activities-list');

    } catch (error) {
        console.error("Failed to refresh home page data:", error);
        // อาจจะแสดง Pop-up เล็กๆ ว่ารีเฟรชไม่สำเร็จ
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
                        <img src="${getFullImageUrl(b.img)}" class="badge-icon ${lockClass}" onerror="this.onerror=null;this.src='https://placehold.co/60x60/e9ecef/6c757d?text=Badge';">
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
function bindStaticEventListeners() {
    $('.nav-link').on('click', function(e) {
        e.preventDefault();
        const pageId = $(this).data('page');
        if (pageId) {
            $('.nav-link').removeClass('active');
            $(this).addClass('active');
            $('.page').removeClass('active');
            $('#' + pageId).addClass('active');
            if (pageId === 'leaderboard-page') loadLeaderboard();
            if (pageId === 'profile-page') loadUserBadges();
            if (pageId === 'admin-page') loadAdminDashboard();
            $('#leaderboard-load-more-btn').on('click', () => loadLeaderboard(true));
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
}

function bindAdminEventListeners() {
    $('#view-stats-btn').on('click', handleViewStats);
    $('#manage-reports-btn').on('click', handleManageReports);
    $('#manage-activities-btn').on('click', handleManageActivities);
    $('#manage-badges-btn').on('click', handleManageBadges);
    $('#create-activity-btn').on('click', handleCreateActivity);
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
           loadAndShowActivityDetails(currentActivityId, activityTitle);
        }
    } catch (e) { 
        showError('ไม่สามารถเพิ่มความคิดเห็นได้'); 
    } finally {
        btn.prop('disabled', false); 
    }
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
            await callApi(`/api/admin/submissions/approve`, { submissionId: id, score: score }, 'POST');
        } else {
            await callApi(`/api/admin/submissions/reject`, { submissionId: id }, 'POST');
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
    
    $('#user-details-badges-container').html('<div class="text-center"><div class="spinner-border"></div></div>');
    modal.show();

    try {
        const data = await callApi(`/api/admin/user-details/${lineUserId}`);
        $('#user-details-pic').attr('src', getFullImageUrl(data.user.pictureUrl));
        $('#user-details-name').text(data.user.fullName);
        $('#user-details-info').text(`รหัส: ${data.user.employeeId} | คะแนน: ${data.user.totalScore}`);

        const badgesContainer = $('#user-details-badges-container');
        badgesContainer.empty();
        
        if (data.allBadges.length === 0) {
            badgesContainer.html('<p class="text-center text-muted">ยังไม่มีป้ายรางวัลในระบบ</p>');
            return;
        }

        const badgesHtml = data.allBadges.map(badge => {
            const isEarned = data.earnedBadgeIds.includes(badge.badgeId);
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
                </div>
            `;
        }).join('');
        badgesContainer.html(badgesHtml);

    } catch (e) {
        showError(e.message);
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
                                    <h6 class="card-title fw-bold">${sanitizeHTML(s.submitter.fullName)}</h6>
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
                                <small class="text-muted d-block mb-3">${sanitizeHTML(b.description)}</small>
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

async function fetchAdminUsers(page, query, isLoadMore = false) {
    const resultsContainer = $('#user-search-results');
    const loadMoreContainer = $('#users-load-more-container');
    const loadMoreBtn = $('#users-load-more-btn');

    if (!isLoadMore) {
        // ถ้าเป็นการโหลดครั้งแรก ให้แสดง Spinner และรีเซ็ตค่า
        resultsContainer.html('<div class="text-center my-4"><div class="spinner-border text-success"></div></div>');
        AppState.adminUsers.currentPage = 1;
        AppState.adminUsers.hasMore = true;
    }

    if (!AppState.adminUsers.hasMore) return; // ถ้าไม่มีข้อมูลให้โหลดแล้ว ก็หยุด
    loadMoreBtn.prop('disabled', true);

    try {
        // เรียก API พร้อมส่ง page และ search query ไปด้วย
        const users = await callApi('/api/admin/users', { search: query, page: page });

        if (!isLoadMore) resultsContainer.empty(); // ถ้าเป็นการโหลดครั้งแรก ให้ล้างข้อมูลเก่าทิ้ง

        if (users.length === 0 && !isLoadMore) {
            resultsContainer.html('<p class="text-center text-muted my-4">ไม่พบผู้ใช้งาน</p>');
            loadMoreContainer.hide();
            return;
        }

        renderUserListForAdmin(users, resultsContainer); // เรียกใช้ฟังก์ชันแสดงผล

        if (users.length < 30) {
            // ถ้าข้อมูลที่ได้กลับมาน้อยกว่า 30 แสดงว่าหมดแล้ว
            AppState.adminUsers.hasMore = false;
            loadMoreContainer.hide();
        } else {
            // ถ้ายังมีข้อมูลอีก ก็ให้เพิ่มหมายเลขหน้าและแสดงปุ่ม "โหลดเพิ่มเติม"
            AppState.adminUsers.currentPage++;
            loadMoreContainer.show();
        }

    } catch (e) {
        if (!isLoadMore) resultsContainer.html('<p class="text-center text-danger my-4">ไม่สามารถโหลดข้อมูลได้</p>');
    } finally {
        loadMoreBtn.prop('disabled', false);
    }
}

function renderUserListForAdmin(users, container) {
    // เราจะไม่ .empty() ที่นี่แล้ว
    users.forEach(user => {
        const html = `
            <div class="card shadow-sm mb-2 user-card" style="cursor: pointer;" data-userid="${user.lineUserId}">
                <div class="card-body p-2">
                    <div class="d-flex align-items-center">
                        <img src="${getFullImageUrl(user.pictureUrl) || 'https://placehold.co/45x45'}" class="rounded-circle me-3" width="45" height="45" alt="Profile">
                        <div class="flex-grow-1">
                            <h6 class="fw-bold mb-0">${sanitizeHTML(user.fullName)}</h6>
                            <small class="text-muted">รหัส: ${sanitizeHTML(user.employeeId)} | คะแนน: ${user.totalScore} | <i class="fas fa-certificate text-warning"></i> ${user.badgeCount}</small>
                        </div>
                        <i class="fas fa-chevron-right ms-auto text-muted"></i>
                    </div>
                </div>
            </div>`;
        container.append(html);
    });
}
// ===== END: Updated User Search/Load functions for Idea 3 =====

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