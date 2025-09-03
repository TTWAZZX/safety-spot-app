// ===============================================================
//  APP CONFIGURATION
// ===============================================================
const API_BASE_URL = "https://shesafety-spot-appbackend.onrender.com";
const LIFF_ID = "2007053300-9xLKdwZp";

// Global variables
let lineProfile = {}; 
let allModals = {};
let currentUser = {};
let reportsChart;

// ===============================================================
//  INITIALIZATION
// ===============================================================
$(document).ready(function() {
    initializeAllModals();
    initializeApp();
    bindStaticEventListeners();
    bindAdminTabEventListeners();
});

function initializeAllModals() {
    const modalIds = ['submission', 'admin-reports', 'admin-activities', 'activity-form', 'activity-detail', 'admin-stats', 'admin-manage-badges', 'badge-form'];
    modalIds.forEach(id => {
        allModals[id] = new bootstrap.Modal(document.getElementById(`${id}-modal`));
    });
}

async function initializeApp() {
    try {
        showLoading('กำลังเริ่มต้น...');
        await liff.init({ liffId: LIFF_ID });

        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }

        lineProfile = await liff.getProfile();
        const result = await callApi('/api/user/profile', { lineUserId: lineProfile.userId });
        
        if (result.registered) {
            await showMainApp(result.user);
        } else {
            $('#registration-page').fadeIn();
            Swal.close();
        }
    } catch (error) {
        console.error("Initialization failed:", error);
        showError('ไม่สามารถเริ่มต้นแอปพลิเคชันได้ กรุณาลองใหม่อีกครั้ง');
    }
}

async function showMainApp(userData) {
    currentUser = userData;
    updateUserInfoUI(currentUser);
    
    if (currentUser.isAdmin) {
        $('#admin-nav-item').show();
        bindAdminEventListeners();
    }

    const activities = await callApi('/api/activities');
    displayActivitiesUI(activities, 'latest-activities-list');
    displayActivitiesUI(activities, 'all-activities-list');
    
    $('#main-app').fadeIn();
    Swal.close();
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
    if (currentUser.lineUserId) {
         options.headers['X-Admin-User-ID'] = currentUser.lineUserId;
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
    $('#user-profile-pic, #profile-page-pic').attr('src', user.pictureUrl || 'https://placehold.co/80x80');
    $('#user-display-name, #profile-page-name').text(user.fullName);
    $('#user-employee-id').text(`รหัส: ${user.employeeId}`);
    $('#profile-page-employee-id').text(`รหัสพนักงาน: ${user.employeeId}`);
    $('#user-score, #profile-page-score').text(user.totalScore);
}

function displayActivitiesUI(activities, listId) {
    const listElement = $(`#${listId}`);
    listElement.empty();
    if (!activities || activities.length === 0) {
        listElement.html('<p class="text-center text-muted">ยังไม่มีกิจกรรมในขณะนี้</p>');
        return;
    }
    activities.forEach(act => {
        const cardHtml = `
            <div class="card shadow-sm mb-3">
                <img src="${getFullImageUrl(act.imageUrl)}" class="card-img-top" style="height:150px;object-fit:cover;" onerror="this.onerror=null;this.src='https://placehold.co/600x300/e9ecef/6c757d?text=Image';">
                <div class="card-body">
                    <h5 class="card-title fw-bold">${sanitizeHTML(act.title)}</h5>
                    <p class="card-text text-muted small">${sanitizeHTML(act.description)}</p>
                    <div class="d-flex justify-content-between gap-2 mt-3">
                        <button class="btn btn-outline-secondary btn-view-report w-50 py-2" data-activity-id="${act.activityId}" data-activity-title="${sanitizeHTML(act.title)}">
                            <i class="fas fa-eye me-1"></i> ดูรายงาน
                        </button>
                        <button class="btn btn-primary btn-join-activity w-50 py-2" data-activity-id="${act.activityId}" data-activity-title="${sanitizeHTML(act.title)}">
                            <i class="fas fa-plus-circle me-1"></i> เข้าร่วม
                        </button>
                    </div>
                </div>
            </div>`;
        listElement.append(cardHtml);
    });
}

// NEW, REDESIGNED submission rendering function
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
                <img src="${c.commenter.pictureUrl || 'https://placehold.co/32x32'}" class="rounded-circle me-2 comment-profile-pic" alt="Profile">
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
                        ${currentUser.isAdmin ? `<button class="btn btn-sm btn-outline-danger btn-delete-submission" data-id="${sub.submissionId}"><i class="fas fa-trash-alt"></i></button>` : ''}
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
    if(reportsChart) {
        reportsChart.destroy();
    }
    reportsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartData.labels,
            datasets: [{
                label: 'จำนวนรายงาน',
                data: chartData.data,
                backgroundColor: 'rgba(40, 167, 69, 0.6)',
                borderColor: 'rgba(40, 167, 69, 1)',
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
    modal.data('current-activity-id', activityId); // Store activity ID for later use
    $('#activity-detail-title').text(activityTitle);
    
    const container = $('#submissions-container');
    $('#submissions-loading').show();
    container.empty();
    allModals['activity-detail'].show();
    try {
        const submissions = await callApi('/api/submissions', { activityId, lineUserId: lineProfile.userId });
        renderSubmissions(submissions);
    } catch (error) { 
        container.html('<p class="text-center text-danger">ไม่สามารถโหลดข้อมูลรายงานได้</p>'); 
    } finally { 
        $('#submissions-loading').hide(); 
    }
}

async function loadLeaderboard() {
    const list = $('#leaderboard-list');
    const loading = $('#leaderboard-loading');
    list.empty();
    loading.show();
    try {
        const users = await callApi('/api/leaderboard');
        loading.hide();
        users.forEach((user, index) => {
            const rank = index + 1;
            let rankDisplay = rank;
            if (rank === 1) rankDisplay = '<i class="fas fa-trophy"></i>';
            else if (rank === 2) rankDisplay = '<i class="fas fa-medal text-secondary"></i>';
            else if (rank === 3) rankDisplay = '<i class="fas fa-medal" style="color:#cd7f32;"></i>';

            const itemHtml = `
                <div class="d-flex align-items-center p-2 mb-2 bg-white rounded-3 shadow-sm leaderboard-item">
                    <div class="leaderboard-rank me-3">${rankDisplay}</div>
                    <img src="${user.pictureUrl}" class="rounded-circle me-3" width="45" height="45" onerror="this.onerror=null;this.src='https://placehold.co/45x45';">
                    <div class="flex-grow-1">
                        <div class="fw-bold">${sanitizeHTML(user.fullName)}</div>
                    </div>
                    <div class="fw-bold" style="color: var(--safety-green);">${user.totalScore} คะแนน</div>
                </div>`;
            list.append(itemHtml);
        });
    } catch (error) {
        loading.hide();
        list.html('<p class="text-center text-danger">ไม่สามารถโหลดข้อมูลได้</p>');
    }
}

async function loadUserBadges() {
    const container = $('#badges-container');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    container.html('<div class="spinner-border"></div>');
    try {
        const badges = await callApi('/api/user/badges', { lineUserId: lineProfile.userId });
        container.empty();
        if (badges.length === 0) {
            container.html('<p class="text-muted">ยังไม่มีป้ายรางวัล</p>');
        } else {
            badges.forEach(b => {
                const lockClass = b.isEarned ? '' : 'locked';
                const html = `
                    <div class="text-center" title="${sanitizeHTML(b.name)}: ${sanitizeHTML(b.desc)}">
                        <img src="${getFullImageUrl(b.img)}" class="badge-icon ${lockClass}" onerror="this.onerror=null;this.src='https://placehold.co/60x60/e9ecef/6c757d?text=Badge';">
                        <div class="small">${sanitizeHTML(b.name)}</div>
                    </div>`;
                container.append(html);
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
// ===== highlight-start =====
// แก้ไขโดยการรวมฟังก์ชันที่ซ้ำซ้อน และเพิ่ม Event Listener สำหรับปุ่มดูรูปภาพ
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

    // Event listener สำหรับปุ่มดูรูปภาพตัวใหม่
    $(document).on('click', '.view-image-btn', function(e) {
        e.preventDefault(); // ป้องกันการเลื่อนหน้าจอ
        const imageUrl = $(this).data('image-full-url');
        if (imageUrl) {
            // นำ URL ไปใส่ใน Modal
            $('#imageViewerContent').attr('src', imageUrl);
            $('#downloadImageBtn').attr('href', imageUrl);

            // สั่งให้ Modal แสดงผลด้วย JavaScript โดยตรง
            const imageViewerModal = new bootstrap.Modal(document.getElementById('imageViewerModal'));
            imageViewerModal.show();
        }
    });
}
// ===== highlight-end =====

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
    $(document).on('click', '.award-badge-btn', handleAwardBadge);
    $(document).on('click', '.btn-edit-badge', handleEditBadge);
    $(document).on('click', '.btn-delete-activity', handleDeleteActivity);
    $(document).on('click', '.btn-delete-submission', handleDeleteSubmission);
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
        const newUser = await callApi("/api/user/register", { lineUserId: lineProfile.userId, displayName: lineProfile.displayName, pictureUrl: lineProfile.pictureUrl, fullName: fullName, employeeId: employeeId }, 'POST');
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
        const payload = { lineUserId: lineProfile.userId, activityId: $('#activityId-input').val(), description: description, imageUrl: imageUrl };
        await callApi('/api/submissions', payload, 'POST');
        allModals.submission.hide();
        $('#submission-form')[0].reset();
        $('#submission-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
        showSuccess('รายงานของคุณถูกส่งเพื่อรอการตรวจสอบ');
    } catch (error) { showError(error.message); }
}

function handleViewReport() {
    console.log("handleViewReport clicked!");
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');
    loadAndShowActivityDetails(activityId, activityTitle);
}

function handleJoinActivity() {
    console.log("handleJoinActivity clicked!");
    const activityId = $(this).data('activity-id');
    const activityTitle = $(this).data('activity-title');
    $('#activityId-input').val(activityId);
    $('#activity-title-modal').text(activityTitle);
    allModals['submission'].show();
}

async function handleLike(e) {
    e.preventDefault();
    const btn = $(this);
    const submissionId = btn.data('submission-id');
    btn.css('pointer-events', 'none'); // Disable click
    try {
        const result = await callApi('/api/submissions/like', { submissionId, lineUserId: lineProfile.userId }, 'POST');
        const countSpan = btn.find('.like-count');
        countSpan.text(result.newLikeCount);
        btn.toggleClass('liked', result.status === 'liked');
    } catch (error) {
        console.error("Like failed:", error);
    } finally {
        btn.css('pointer-events', 'auto'); // Re-enable click
    }
}

// UPDATED comment handler
async function handleComment(e) {
    e.preventDefault();
    const btn = $(this);
    const submissionId = btn.data('submission-id');
    const input = btn.siblings('.comment-input');
    const commentText = input.val().trim();
    if(!commentText) return;
    
    btn.prop('disabled', true);
    
    try {
        await callApi('/api/submissions/comment', { submissionId, lineUserId: lineProfile.userId, commentText }, 'POST');
        
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

// --- Admin Handlers (abbreviated for brevity, no changes needed here) ---
function handleViewStats() { loadAdminStats(); allModals['admin-stats'].show(); }
function handleManageReports() { loadPendingSubmissions(); allModals['admin-reports'].show(); }
function handleManageActivities() { loadAllActivitiesForAdmin(); allModals['admin-activities'].show(); }
function handleCreateActivity() {
    $('#activity-form-title').text('สร้างกิจกรรมใหม่');
    $('#activity-form')[0].reset();
    $('#form-activity-id').val('');
    $('#activity-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
    allModals['activity-form'].show();
}
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

        const payload = {
            activityId: $('#form-activity-id').val(),
            title: $('#form-activity-title').val(),
            description: $('#form-activity-desc').val(),
            imageUrl: finalImageUrl
        };

        const isUpdate = !!payload.activityId;
        const method = isUpdate ? 'PUT' : 'POST';
        await callApi('/api/admin/activities', payload, method);
        
        allModals['activity-form'].hide();
        showSuccess('บันทึกกิจกรรมเรียบร้อย');
        loadAllActivitiesForAdmin();
        const activities = await callApi('/api/activities');
        displayActivitiesUI(activities, 'latest-activities-list');
        displayActivitiesUI(activities, 'all-activities-list');
    } catch (e) {
        showError(e.message);
    }
}
async function handleDeleteActivity() {
    const activityId = $(this).data('id');
    const result = await Swal.fire({
        title: 'แน่ใจหรือไม่?',
        text: "คุณต้องการลบกิจกรรมนี้และรายงานทั้งหมดที่เกี่ยวข้องใช่ไหม?",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'ใช่, ลบเลย!',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        showLoading('กำลังลบกิจกรรม...');
        try {
            await callApi(`/api/admin/activities/${activityId}`, {}, 'DELETE');
            showSuccess('ลบกิจกรรมเรียบร้อย');
            loadAllActivitiesForAdmin();
            const activities = await callApi('/api/activities');
            displayActivitiesUI(activities, 'latest-activities-list');
            displayActivitiesUI(activities, 'all-activities-list');
        } catch (e) {
            showError(e.message);
        }
    }
}
async function handleApprovalAction() {
    const btn = $(this);
    const action = btn.hasClass('btn-approve') ? 'approve' : 'reject';
    const id = btn.data('id');
    const score = $(`#score-input-${id}`).val();
    const row = $(`#row-${id}`);
    row.css('opacity', '0.5');
    btn.prop('disabled', true).parent().find('button').prop('disabled', true);
    try {
        if (action === 'approve') {
            await callApi(`/api/admin/submissions/approve`, { submissionId: id, score: score }, 'POST');
        } else {
            await callApi(`/api/admin/submissions/reject`, { submissionId: id }, 'POST');
        }
        row.fadeOut(500, function() { 
            $(this).remove(); 
            const newCount = $('#submissions-table-body tr').length;
            $('#pending-count-modal').text(newCount);
            if(newCount === 0) $('#no-reports-message').show();
        });
    } catch (e) {
        showError('เกิดข้อผิดพลาด');
        row.css('opacity', '1');
        btn.prop('disabled', false).parent().find('button').prop('disabled', false);
    }
}
async function handleEditActivity() {
    const data = JSON.parse(decodeURIComponent($(this).data('activity-data')));
    $('#activity-form-title').text('แก้ไขกิจกรรม');
    $('#activity-form')[0].reset();
    $('#form-activity-id').val(data.activityId);
    $('#form-activity-title').val(data.title);
    $('#form-activity-desc').val(data.description);
    $('#form-activity-image-url').val(data.imageUrl);
    $('#activity-image-preview').attr('src', getFullImageUrl(data.imageUrl));
    allModals['activity-form'].show();
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
    allModals['admin-manage-badges'].show();
    $('.admin-tab-btn[data-tab="manageBadges"]').addClass('active').siblings().removeClass('active');
    $('#manageBadgesTab').show().siblings('.admin-tab-content').hide();
    loadBadgesForAdmin();
}
function handleAddBadge() {
    $('#badge-form-title').text('เพิ่มป้ายรางวัลใหม่');
    $('#badge-form')[0].reset();
    $('#badge-image-preview').attr('src', 'https://placehold.co/400x300/e9ecef/6c757d?text=Preview');
    allModals['badge-form'].show();
}
async function handleSaveBadge(e) {
    e.preventDefault();
    showLoading('กำลังบันทึก...');
    const imageFile = $('#badge-image-input')[0].files[0];
    const payload = {
        badgeName: $('#badge-name-input').val(),
        description: $('#badge-desc-input').val(),
        badgeId: $('#badge-id-input').val()
    };
    
    try {
        let finalImageUrl = $('#badge-image-url-input').val();
        if (imageFile) {
            finalImageUrl = await uploadImage(imageFile);
        }
        payload.imageUrl = finalImageUrl;

        const method = payload.badgeId ? 'PUT' : 'POST';
        const url = payload.badgeId ? `/api/admin/badges/${payload.badgeId}` : '/api/admin/badges';
        await callApi(url, payload, method);
        
        allModals['badge-form'].hide();
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

    allModals['badge-form'].show();
}
async function handleAwardBadge() {
    const btn = $(this);
    const userId = btn.data('user-id');
    const badgeId = btn.data('badge-id');
    const userName = btn.closest('.card').find('h6').text();

    const result = await Swal.fire({
        title: `ยืนยันการมอบป้ายรางวัล`,
        text: `คุณต้องการมอบป้าย "${btn.text()}" ให้กับคุณ ${userName} ใช่หรือไม่?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: 'var(--safety-green)',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'ยืนยัน',
        cancelButtonText: 'ยกเลิก'
    });

    if (result.isConfirmed) {
        showLoading('กำลังมอบป้ายรางวัล...');
        btn.prop('disabled', true);
        try {
            await callApi('/api/admin/award-badge', { lineUserId: userId, badgeId: badgeId }, 'POST');
            btn.text('มอบแล้ว').addClass('btn-success').removeClass('btn-outline-primary').prop('disabled', true);
            showSuccess('มอบป้ายรางวัลเรียบร้อย');
        } catch (e) {
            showError(e.message);
            btn.prop('disabled', false);
        }
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
async function loadPendingSubmissions() {
    const tableBody = $('#submissions-table-body');
    $('#reports-loading').show();
    $('#no-reports-message').hide();
    tableBody.empty();
    try {
        const subs = await callApi('/api/admin/submissions/pending');
        $('#pending-count-modal').text(subs.length);
        if (subs.length === 0) {
            $('#no-reports-message').show();
        } else {
            subs.forEach(s => {
                const imageUrl = s.imageUrl ? `<a href="${s.imageUrl}" target="_blank" class="btn btn-sm btn-outline-primary">ดูรูป</a>` : 'ไม่มี';
                const row = `
                    <tr id="row-${s.submissionId}">
                        <td><div class="fw-bold">${sanitizeHTML(s.submitter.fullName)}</div><small class="text-muted">${new Date(s.createdAt).toLocaleString()}</small></td>
                        <td style="white-space: pre-wrap; word-break: break-word;">${sanitizeHTML(s.description)}</td>
                        <td>${imageUrl}</td>
                        <td>
                            <div class="d-flex align-items-center flex-wrap gap-1">
                                <input type="number" id="score-input-${s.submissionId}" class="form-control form-control-sm" value="10" min="0" style="width: 70px;">
                                <button class="btn btn-success btn-sm btn-approve" data-id="${s.submissionId}">✓</button>
                                <button class="btn btn-danger btn-sm btn-reject" data-id="${s.submissionId}">✗</button>
                            </div>
                        </td>
                    </tr>`;
                tableBody.append(row);
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
        list.empty();
        acts.forEach(a => {
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
                        <div class="card h-100 shadow-sm text-center">
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
        console.error("Error loading admin badges:", e);
        list.html('<p class="text-center text-danger my-4">ไม่สามารถโหลดป้ายรางวัลได้</p>');
    }
}
async function loadUsersForAdmin() {
    const resultsContainer = $('#user-search-results');
    resultsContainer.html('<div class="text-center my-4"><div class="spinner-border text-success"></div><p class="text-muted mt-2">กำลังโหลดผู้ใช้...</p></div>');
    try {
        const [users, allBadges] = await Promise.all([
            callApi('/api/admin/users'), // โหลดผู้ใช้ทั้งหมด
            callApi('/api/admin/badges') // โหลดป้ายรางวัลทั้งหมดเพื่อเปรียบเทียบ
        ]);

        resultsContainer.empty();
        if (users.length === 0) {
            resultsContainer.html('<p class="text-center text-muted my-4">ไม่พบผู้ใช้งาน</p>');
            return;
        }

        users.forEach(user => {
            const earnedBadgeIds = user.earnedBadgeIds || []; // รายการ ID ป้ายรางวัลที่ผู้ใช้มี
            const badgesToAwardHtml = allBadges.filter(b => !earnedBadgeIds.includes(b.badgeId)) // กรองเฉพาะป้ายที่ผู้ใช้ยังไม่มี
                                                        .map(b => `<button class="btn btn-sm btn-outline-primary award-badge-btn me-1 mb-1" data-user-id="${user.lineUserId}" data-badge-id="${b.badgeId}">${sanitizeHTML(b.badgeName)}</button>`)
                                                        .join('');

            const html = `
                <div class="card shadow-sm mb-3">
                    <div class="card-body">
                        <div class="d-flex align-items-center mb-3">
                            <img src="${getFullImageUrl(user.pictureUrl) || 'https://placehold.co/45x45'}" class="rounded-circle me-3" width="45" height="45" alt="Profile">
                            <div>
                                <h6 class="fw-bold mb-0">${sanitizeHTML(user.fullName)}</h6>
                                <small class="text-muted">รหัส: ${sanitizeHTML(user.employeeId)} | คะแนน: ${user.totalScore}</small>
                            </div>
                        </div>
                        <hr>
                        <p class="fw-bold mb-2">ป้ายรางวัลที่มอบให้ได้:</p>
                        <div class="badges-award-container">
                            ${badgesToAwardHtml || '<small class="text-muted">ผู้ใช้ได้รับป้ายรางวัลทั้งหมดแล้ว หรือยังไม่มีป้ายรางวัลให้มอบ</small>'}
                        </div>
                    </div>
                </div>`;
            resultsContainer.append(html);
        });
    } catch (e) {
        console.error("Error loading users for admin:", e);
        resultsContainer.html('<p class="text-center text-danger my-4">ไม่สามารถโหลดรายชื่อผู้ใช้ได้</p>');
    }
}
async function searchUsersForAdmin(query) {
    const resultsContainer = $('#user-search-results');
    resultsContainer.html('<div class="text-center my-4"><div class="spinner-border text-success"></div><p class="text-muted mt-2">กำลังค้นหาผู้ใช้...</p></div>');
    try {
        const [users, allBadges] = await Promise.all([
            callApi('/api/admin/users', { search: query }), // ส่ง query ไปค้นหา
            callApi('/api/admin/badges')
        ]);

        resultsContainer.empty();
        if (users.length === 0) {
            resultsContainer.html('<p class="text-center text-muted my-4">ไม่พบผู้ใช้งานที่ตรงกับการค้นหา</p>');
            return;
        }

        users.forEach(user => {
            const earnedBadgeIds = user.earnedBadgeIds || [];
            const badgesToAwardHtml = allBadges.filter(b => !earnedBadgeIds.includes(b.badgeId))
                                                        .map(b => `<button class="btn btn-sm btn-outline-primary award-badge-btn me-1 mb-1" data-user-id="${user.lineUserId}" data-badge-id="${b.badgeId}">${sanitizeHTML(b.badgeName)}</button>`)
                                                        .join('');

            const html = `
                <div class="card shadow-sm mb-3">
                    <div class="card-body">
                        <div class="d-flex align-items-center mb-3">
                            <img src="${getFullImageUrl(user.pictureUrl) || 'https://placehold.co/45x45'}" class="rounded-circle me-3" width="45" height="45" alt="Profile">
                            <div>
                                <h6 class="fw-bold mb-0">${sanitizeHTML(user.fullName)}</h6>
                                <small class="text-muted">รหัส: ${sanitizeHTML(user.employeeId)} | คะแนน: ${user.totalScore}</small>
                            </div>
                        </div>
                        <hr>
                        <p class="fw-bold mb-2">ป้ายรางวัลที่มอบให้ได้:</p>
                        <div class="badges-award-container">
                            ${badgesToAwardHtml || '<small class="text-muted">ผู้ใช้ได้รับป้ายรางวัลทั้งหมดแล้ว หรือยังไม่มีป้ายรางวัลให้มอบ</small>'}
                        </div>
                    </div>
                </div>`;
            resultsContainer.append(html);
        });
    } catch (e) {
        console.error("Error searching users for admin:", e);
        resultsContainer.html('<p class="text-center text-danger my-4">ไม่สามารถค้นหาผู้ใช้ได้</p>');
    }
}

// ===============================================================
//  UTILITY FUNCTIONS
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