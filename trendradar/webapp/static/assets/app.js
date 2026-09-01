/**
 * 选题终端 · 前端应用
 * 原生 JS 单 IIFE，挂载 window.TerminalApp；零构建、零框架。
 * 结构：工具 → 状态 → API → 顶栏 → TOP10 → 头条流 → 热榜列 → 详情面板 → 设置弹窗 → 启动
 */
(function () {
    'use strict';

    // ═══════════════════════════════════════
    //  工具函数
    // ═══════════════════════════════════════

    function esc(text) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(String(text == null ? '' : text)));
        return div.innerHTML;
    }

    function $(sel, root) { return (root || document).querySelector(sel); }

    function apiGet(path) {
        return fetch(path).then(function (res) {
            if (!res.ok && res.status !== 200) return res.json().then(throwApiError);
            return res.json();
        }).then(checkEnvelope);
    }

    function apiSend(method, path, data) {
        return fetch(path, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || {}),
        }).then(function (res) {
            if (res.status === 204) return { ok: true };
            return res.json().then(function (j) {
                if (!res.ok && !j.ok) throwApiError(j);
                return j;
            });
        }).then(checkEnvelope);
    }

    function throwApiError(envelope) {
        var msg = (envelope && envelope.error && envelope.error.message) || ('HTTP ' + (envelope && envelope.status || ''));
        throw new Error(msg);
    }

    function checkEnvelope(json) {
        if (!json || json.ok !== true) {
            throw new Error((json && json.error && json.error.message) || 'unknown error');
        }
        return json.data;
    }

    function toast(message, level) {
        level = level || 'ok';
        var wrap = $('#toast-wrap');
        var el = document.createElement('div');
        el.className = 'toast ' + level;
        var icon = level === 'ok' ? 'fa-circle-check'
            : level === 'error' ? 'fa-circle-exclamation'
            : level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info';
        el.innerHTML = '<i class="fa-solid ' + icon + '"></i><span>' + esc(message) + '</span>';
        wrap.appendChild(el);
        setTimeout(function () { el.classList.add('fade-out'); }, 2600);
        setTimeout(function () { el.remove(); }, 3050);
    }

    /** 任务轮询：1.5s 起指数退避，至多 5s；state=done/error 时回调并停止 */
    function pollTask(taskId, onDone, onError, onProgress) {
        var delay = 1500;
        var notify = onProgress || function () {};
        function tick() {
            apiGet('/api/tasks/' + taskId).then(function (task) {
                if (task.state === 'done') { onDone(task); return; }
                if (task.state === 'error') { onError(new Error(task.error || 'task failed')); return; }
                notify(task);
                delay = Math.min(delay * 1.4, 5000);
                setTimeout(tick, delay);
            }).catch(function (err) { onError(err); });
        }
        setTimeout(tick, delay);
        return taskId;
    }

    function weekKey(d) {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function markKeywords(title) {
        var keywords = (State.profile.keywords || []);
        var safeTitle = esc(title);
        if (!keywords.length) return safeTitle;
        keywords.forEach(function (kw) {
            if (!kw) return;
            try {
                var re = new RegExp('(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                safeTitle = safeTitle.replace(new RegExp('&[^;]+;|<[^>]+>|' + re.source, 'gi'), function (m) {
                    if (/^&[^;]+;$/.test(m) || /^<[^>]+>$/.test(m)) return m;
                    return '<span class="title-mark">' + m + '</span>';
                });
            } catch (e) { /* invalid pattern — skip */ }
        });
        return safeTitle;
    }

    function timeAgoLabel(minutesAgo) {
        if (minutesAgo < 2) return t('tt.justNow');
        return t('tt.minAgo', minutesAgo);
    }

    /** 把文件名风格的 "21-06"（Windows 文件名不允许冒号）归一化为显示用 "21:06" */
    function normalizeClock(raw) {
        if (!raw) return '';
        var s = String(raw).trim();
        var m = /^(\d{1,2})-(\d{2})$/.exec(s);
        return m ? m[1] + ':' + m[2] : s;
    }

    /** 基于热榜数据日 + 抓取时刻，追加 "· 3 分钟前" 这类实时新鲜度提示；太久远/未来则省略 */
    function hotFreshSuffix(time) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(time);
        var dateStr = (State.hotlists && State.hotlists.date) || '';
        if (!m || !dateStr) return '';
        var d = new Date(dateStr + 'T' + time + ':00');
        if (isNaN(d.getTime())) return '';
        var mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 0 || mins >= 60) return '';
        return ' · ' + timeAgoLabel(mins);
    }

    // ═══════════════════════════════════════
    //  全局状态
    // ═══════════════════════════════════════

    var State = {
        bootstrap: null,
        profile: { nickname: '', keywords: [], interests: '', source_prefs: {} },
        hotlists: null,
        stream: null,
        top10: null,
        itemIndex: {},       // key -> {item, kind:'hot'|'stream'|'top', sourceName}
        selectedKey: null,
        interestOnly: false,
        activeTaskId: null,
        lastHotFetchMs: 0,
        library: [],         // 选题库条目
        libTitles: {},       // 小写标题 -> true（TOP10 卡片「已入库」态）
        libExpanded: false,  // 选题库是否展开（默认折叠，仅显示前 5 条）
    };

    window.TerminalApp = { state: State };

    // ═══════════════════════════════════════
    //  数据加载
    // ═══════════════════════════════════════

    function loadBootstrap() {
        return apiGet('/api/bootstrap').then(function (data) {
            State.bootstrap = data;
            renderStatus(data.status);
            renderSourceStats();
            document.title = (data.nickname || '') + t('tt.titleSuffix');
        });
    }

    function loadProfile() {
        return apiGet('/api/profile').then(function (data) {
            State.profile = data.profile;
            renderNickname(data.profile.nickname);
        });
    }

    function reloadTop10() {
        return apiGet('/api/score/top10').then(function (data) {
            State.top10 = data && data.items ? data : null;
            renderTop10();
        }).catch(function () {
            State.top10 = null;
            renderTop10();
        });
    }

    /** 数据源偏好：未在 source_prefs 中配置的默认开启；取消（false）则隐藏该源数据 */
    function isSourceEnabled(id) {
        if (!id) return true;
        var prefs = (State.profile && State.profile.source_prefs) || {};
        return prefs[id] !== false;
    }

    function reloadHotlists(silent) {
        return apiGet('/api/hotlists?limit=30').then(function (data) {
            data.platforms = (data.platforms || []).filter(function (g) { return isSourceEnabled(g.id); });
            State.hotlists = data;
            State.matchStats = data.match_stats || null;
            renderMatchStats();
            rebuildItemIndex();
            renderHotGrid(!silent);
            renderHotUpdated(data.fetched_at);
        }).catch(function (err) {
            if (!silent) showError($('#hot-grid'), err.message);
        });
    }

    function reloadStream(silent) {
        var onlyParam = State.interestOnly ? '&interest_only=1' : '';
        return apiGet('/api/rss?hours=24&limit=120' + onlyParam).then(function (data) {
            data.items = (data.items || []).filter(function (it) { return isSourceEnabled(it.source_id); });
            State.stream = data;
            rebuildItemIndex();
            renderStream(!silent);
        }).catch(function (err) {
            if (!silent) showError($('#auth-stream'), err.message);
        });
    }

    function reloadAllData(silent) {
        return Promise.all([reloadHotlists(silent), reloadStream(silent)]);
    }

    function rebuildItemIndex() {
        State.itemIndex = {};
        (State.hotlists && State.hotlists.platforms || []).forEach(function (group) {
            (group.items || []).forEach(function (item) {
                State.itemIndex[item.key] = { item: item, kind: 'hot', sourceName: group.name };
            });
        });
        (State.stream && State.stream.items || []).forEach(function (item) {
            if (!State.itemIndex[item.key]) {
                State.itemIndex[item.key] = { item: item, kind: 'stream', sourceName: item.source_name };
            }
        });
        State.top10 && (State.top10.items || []).forEach(function (item) {
            State.itemIndex[item.key] = { item: item, kind: 'top', sourceName: '' };
        });
    }

    function showError(container, message) {
        container.innerHTML =
            '<div class="empty-state"><i class="fa-solid fa-plug-circle-xmark"></i>' +
            esc(t('tt.loadFail', message)) +
            '<div style="margin-top:8px;"><button class="btn btn-ghost btn-mini" onclick="location.reload()">' + esc(t('tt.retry')) + '</button></div>' +
            '</div>';
        if (container.id === 'hot-grid') layoutHotGrid();
    }

    // ═══════════════════════════════════════
    //  顶栏
    // ═══════════════════════════════════════

    function startClock() {
        function tickClock() {
            var now = new Date();
            var label = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' '
                + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())
                + ' ' + t('tt.week.' + weekKey(now));
            var clockEl = $('#tb-clock');
            if (clockEl) clockEl.textContent = label;

            var todayLocal = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
            if (State.bootstrap && State.bootstrap.date && State.bootstrap.date !== todayLocal && now.getHours() > 3) {
                location.reload();   // 跨天自动整页重载
            }
        }
        tickClock();
        setInterval(tickClock, 1000);
    }

    function renderNickname(name) {
        var el = $('#tb-nickname');
        if (el && name) el.textContent = name;
        if (el) el.title = '';
    }

    /** 顶部订阅统计：数据源总数 · 平台数 · RSS 数 */
    function renderSourceStats() {
        var el = $('#src-stats');
        if (!el) return;
        var b = State.bootstrap;
        if (!b) { el.textContent = ''; return; }
        var plats = (b.platforms || []).length;
        var feeds = (b.feeds || []).length;
        el.textContent = t('tt.srcStats', [plats + feeds, plats, feeds]);
    }

    /** 顶部兴趣命中统计：热榜命中 X/Y · RSS 命中 X/Y（数据随 /api/hotlists 每 5 分钟刷新） */
    function renderMatchStats() {
        var el = $('#match-stats');
        if (!el) return;
        var s = State.matchStats;
        if (!s) { el.textContent = ''; return; }
        el.textContent = t('tt.matchStats', [s.hotlist_matched || 0, s.hotlist_total || 0, s.rss_matched || 0, s.rss_total || 0]);
    }

    function renderStatus(status) {
        var dot = $('#status-dot');
        var wrap = $('#status-wrap');
        var label = $('#status-label');
        if (!dot || !status) return;
        dot.className = 'status-dot ' + status.level;

        var map = { green: 'tt.statusOk', yellow: 'tt.statusWarn', red: 'tt.statusDown' };
        // 当天尚未抓取（platform_total=0）且判定为黄 → 「数据略旧」而非「部分异常」
        var labelText = (status.level === 'yellow' && !status.platform_total)
            ? t('tt.statusStale')
            : t(map[status.level] || 'tt.statusWarn');

        // 分类型计数：平台 X/Y · RSS X/Y（比合计的「正常 X/异常 Y」更直观）
        var parts = [];
        if (status.platform_total) parts.push(t('tt.platform') + ' ' + status.platform_ok + '/' + status.platform_total);
        if (status.rss_total) parts.push('RSS ' + status.rss_ok + '/' + status.rss_total);
        if (parts.length) labelText += ' · ' + parts.join(' · ');
        label.textContent = labelText;

        var detail = [];
        if (status.platform_total) detail.push('热榜 ' + status.platform_ok + '/' + status.platform_total);
        if (status.rss_total) detail.push('RSS ' + status.rss_ok + '/' + status.rss_total);
        if (status.last_crawl) detail.push(t('tt.hotUpdated', normalizeClock(status.last_crawl)));
        if (status.last_available_date && status.last_available_date !== status.date) {
            detail.push('最新数据日: ' + status.last_available_date);
        }
        wrap.setAttribute('title', labelText + '\n' + detail.join('\n'));
    }

    function bindTopbarEvents() {
        // 语言切换
        $('#lang-toggle-btn').addEventListener('click', function () {
            switchTermLang(getTermLang() === 'zh' ? 'en' : 'zh');
        });

        // 昵称内联编辑
        $('#btn-edit-name').addEventListener('click', startEditName);

        // 设置弹窗
        $('#btn-settings').addEventListener('click', openSettings);
        $('#btn-cancel-settings').addEventListener('click', closeSettings);
        $('#settings-modal').addEventListener('mousedown', function (e) {
            if (e.target === this) closeSettings();
        });
    }

    function startEditName() {
        var span = $('#tb-nickname');
        if (span.dataset.editing) return;
        span.dataset.editing = '1';

        var input = document.createElement('input');
        input.className = 'tb-name-input';
        input.maxLength = 30;
        input.value = State.profile.nickname || '';
        span.style.display = 'none';
        span.parentNode.insertBefore(input, span);
        input.focus();
        input.select();

        function commit(save) {
            // 先置空标记，防止 input.remove() 触发的 blur 再次进入 commit
            if (!span.dataset.editing) return;
            span.dataset.editing = '';
            var value = input.value.trim();
            input.remove();
            span.style.display = '';
            if (save && value && value !== State.profile.nickname) {
                saveProfile({ nickname: value }).catch(function (err) {
                    toast(err.message, 'error');
                });
            } else {
                renderNickname(State.profile.nickname);
            }
        }
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            if (e.key === 'Escape') { e.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', function () { commit(true); });  // 失焦即保存，Esc 取消
    }

    // ═══════════════════════════════════════
    //  TOP10 列表
    // ═══════════════════════════════════════

    function renderTop10() {
        var listEl = $('#top10-list');
        var progressEl = $('#top10-progress');
        var genEl = $('#top10-gen');
        var items = (State.top10 && State.top10.items) || [];

        if (State.activeTaskId) {
            progressEl.innerHTML =
                '<div class="task-banner"><i class="fa-solid fa-wand-magic-sparkles fa-spin"></i>' +
                '<span id="top10-task-label">' + esc(t('tt.top10Generating')) + '</span></div>';
        } else {
            progressEl.innerHTML = '';
        }

        if (!items.length) {
            // 选题为空：不展示生成时间（空快照的 generated_at 不代表真正生成）
            if (genEl) genEl.textContent = '';
            listEl.innerHTML =
                '<div class="empty-state"><i class="fa-solid fa-crown"></i><span>' +
                esc(t('tt.top10Empty')) + '</span></div>';
            return;
        }

        // 生成时间（快照 generated_at，如 2026-08-27 22:33:52 → 显示 22:33）
        if (genEl) {
            var gt = (State.top10 && State.top10.generated_at) || '';
            var hm = /(\d{2}):(\d{2}):\d{2}/.exec(gt);
            genEl.textContent = hm ? t('tt.top10Gen', hm[1] + ':' + hm[2]) : '';
        }

        listEl.innerHTML = items.map(function (item, idx) {
            var rankNo = idx + 1;
            var srcChips = (item.sources || []).slice(0, 3).map(function (s) {
                return '<span class="src-chip"><i class="fa-solid fa-circle-dot" style="font-size:6px;"></i>' + esc(s.name) + '</span>';
            }).join('');
            var matchCls = item.match_level === 'high' ? 'high' : (item.match_level === 'mid' ? 'mid' : 'low');
            var matchIcon = item.match_level === 'high' ? '<i class="fa-solid fa-fire"></i> ' : '';

            return (
                '<li class="top-item' + (State.selectedKey === item.key ? ' active' : '') + '" data-key="' + esc(item.key) + '">' +
                  '<span class="rank-num rank-' + rankNo + '">' + pad(rankNo) + '</span>' +
                  '<span class="score-ring">' + scoreRingSvg(item.score) + '</span>' +
                  '<span class="top-mid">' +
                    '<span class="top-title-line">' +
                      '<span class="top-title" title="' + esc(item.title) + '">' + markKeywords(item.title) + '</span>' +
                      '<span class="match-badge ' + matchCls + '" title="' + esc(t('tt.matchHigh')) + '">' + matchIcon + Math.round((item.match_score || 0) * 100) + '%</span>' +
                    '</span>' +
                    '<span class="top-meta">' + srcChips +
                      ((item.merged_count || 1) > 1 ? '<span>' + esc(t('tt.mergedCount', item.merged_count)) + '</span>' : '') +
                      '<span class="ml-auto"></span>' +
                      topicTagsHtml(item) +
                      libAddBtnHtml(item) +
                    '</span>' +
                  '</span>' +
                '</li>'
            );
        }).join('');
    }

    function scoreRingSvg(score) {
        var r = 18;
        var circumference = 2 * Math.PI * r;
        var clamped = Math.max(0, Math.min(100, score || 0));
        var offset = circumference * (1 - clamped / 100);
        return (
            '<svg width="44" height="44" viewBox="0 0 44 44">' +
              '<circle class="ring-track" cx="22" cy="22" r="' + r + '" stroke-width="4"/>' +
              '<circle class="ring-value" cx="22" cy="22" r="' + r + '" stroke-width="4"' +
                ' stroke-dasharray="' + circumference.toFixed(1) + '"' +
                ' stroke-dashoffset="' + offset.toFixed(1) + '"/>' +
            '</svg>' +
            '<span class="score-num">' + Math.round(clamped) + '</span>'
        );
    }

    /** 选题标签：后端聚合 tags + event_type + AI 匹配标签 + 成员标签，去重展示（最多 5 个） */
    function topicTagsHtml(item) {
        var seen = [];
        function push(tag) {
            tag = (tag || '').trim();
            if (tag && seen.indexOf(tag) < 0) seen.push(tag);
        }
        (item && item.tags || []).forEach(push);
        push(item && item.event_type);
        if (item && item.match && item.match.tag) push(item.match.tag);
        (item && item.members || []).forEach(function (m) { push(m.tag); });
        return seen.slice(0, 5).map(function (tag) {
            return '<span class="badge-tag badge-type"><i class="fa-solid fa-tag"></i>' + esc(tag) + '</span>';
        }).join('');
    }

    // ═══════════════════════════════════════
    //  选题库（个人收藏池）
    // ═══════════════════════════════════════

    var LIB_STATUS_CYCLE = { '': 'pending', 'pending': 'doing', 'doing': 'done', 'done': '' };
    var LIB_STATUS_LABELS = { '': 'tt.libStatusNone', 'pending': 'tt.libStatusPending', 'doing': 'tt.libStatusDoing', 'done': 'tt.libStatusDone' };
    var LIB_VISIBLE_MAX = 5;   // 默认折叠：仅展示前 5 条，其余展开查看

    function reloadLibrary() {
        return apiGet('/api/library').then(function (data) {
            State.library = (data && data.items) || [];
            State.libTitles = {};
            State.library.forEach(function (it) {
                State.libTitles[String(it.title || '').toLowerCase()] = true;
            });
            renderLibrary();
        }).catch(function () {
            // 静默降级：接口不可用时选题库保持空态，不打断页面启动
            State.library = [];
            State.libTitles = {};
            renderLibrary();
        });
    }

    function renderLibrary() {
        var listEl = $('#library-list');
        if (!listEl) return;
        var countEl = $('#lib-count');
        var items = State.library || [];

        if (countEl) {
            countEl.textContent = items.length ? t('tt.libCount', items.length) : '';
        }
        if (!items.length) {
            listEl.innerHTML =
                '<div class="empty-state"><i class="fa-solid fa-box-archive"></i><span>' +
                esc(t('tt.libEmpty')) + '</span></div>';
            return;
        }

        var visible = State.libExpanded ? items : items.slice(0, LIB_VISIBLE_MAX);
        var html = visible.map(function (it) {
            return (
                '<li class="lib-item" data-lib-id="' + esc(it.id) + '">' +
                  '<div class="lib-item-main">' +
                    '<div class="lib-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>' +
                    '<div class="lib-meta">' +
                      '<span class="badge-tag lib-origin ' + (it.origin === 'system' ? 'sys' : 'usr') + '">' +
                        esc(t(it.origin === 'system' ? 'tt.libOriginSystem' : 'tt.libOriginUser')) + '</span>' +
                      '<button class="lib-status ' + esc(it.status || 'todo') + '" data-lib-status="' + esc(it.status || '') + '">' +
                        esc(t(LIB_STATUS_LABELS[it.status] || LIB_STATUS_LABELS[''])) + '</button>' +
                    '</div>' +
                  '</div>' +
                  '<button class="icon-btn lib-del" data-lib-del title="' + esc(t('tt.libDelete')) + '">' +
                    '<i class="fa-solid fa-trash-can"></i>' +
                  '</button>' +
                '</li>'
            );
        }).join('');

        if (items.length > LIB_VISIBLE_MAX) {
            html +=
                '<li class="lib-toggle-row"><button class="btn btn-ghost btn-mini" id="btn-lib-toggle">' +
                (State.libExpanded ? '<i class="fa-solid fa-chevron-up"></i>' : '<i class="fa-solid fa-chevron-down"></i>') +
                esc(t(State.libExpanded ? 'tt.showLess' : 'tt.showMore')) +
                '</button></li>';
        }
        listEl.innerHTML = html;

        var toggleBtn = $('#btn-lib-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function () {
                State.libExpanded = !State.libExpanded;
                renderLibrary();
            });
        }

        listEl.querySelectorAll('[data-lib-status]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var itemId = btn.closest('.lib-item').getAttribute('data-lib-id');
                var next = LIB_STATUS_CYCLE[btn.getAttribute('data-lib-status')] || 'pending';
                cycleLibStatus(itemId, next);
            });
        });
        listEl.querySelectorAll('[data-lib-del]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var itemId = btn.closest('.lib-item').getAttribute('data-lib-id');
                deleteLibraryItem(itemId);
            });
        });
    }

    function cycleLibStatus(itemId, status) {
        apiSend('PUT', '/api/library/items/' + itemId, { status: status }).then(function () {
            return reloadLibrary();
        }).catch(function (err) {
            toast(err.message, 'error');
        });
    }

    function deleteLibraryItem(itemId) {
        if (!window.confirm(t('tt.libDeleteConfirm'))) return;
        apiSend('DELETE', '/api/library/items/' + itemId).then(function () {
            toast(t('tt.libDeleted'));
            return reloadLibrary();
        }).catch(function (err) {
            toast(err.message, 'error');
        });
    }

    /** TOP10 卡片「入库」按钮：已入库 → 禁用态；未入库 → data-lib 动作按钮（属性只放 md5 key，不放标题） */
    function libAddBtnHtml(item) {
        var already = State.libTitles[String(item.title || '').toLowerCase()];
        if (already) {
            return '<button class="btn btn-mini lib-add-btn added" disabled><i class="fa-solid fa-check"></i>' +
                   esc(t('tt.libAdded')) + '</button>';
        }
        return '<button class="btn btn-ghost btn-mini lib-add-btn" data-lib="add" data-lib-key="' + esc(item.key) + '">' +
               '<i class="fa-solid fa-box-archive"></i>' + esc(t('tt.libAdd')) + '</button>';
    }

    function handleLibAction(btn) {
        if (btn.getAttribute('data-lib') === 'add') {
            addTopicToLibrary(btn.getAttribute('data-lib-key'));
        }
    }

    function addTopicToLibrary(key) {
        var items = (State.top10 && State.top10.items) || [];
        var item = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i].key === key) { item = items[i]; break; }
        }
        if (!item) {
            toast(t('tt.libDupToast'), 'warn');
            return;
        }
        apiSend('POST', '/api/library/items', {
            title: item.title,
            source_key: item.key,
            tags: (item.tags || []).slice(0, 5),
            url: item.url || '',
        }).then(function (res) {
            toast(res && res.duplicate ? t('tt.libDupToast') : t('tt.libAddToast'));
            return reloadLibrary().then(function () {
                renderTop10();   // 刷新卡片按钮「已入库」态
            });
        }).catch(function (err) {
            toast(err.message, 'error');
        });
    }

    // ---------- 批量上传弹窗 ----------

    function openLibraryImport() {
        $('#lib-import-text').value = '';
        $('#library-modal').classList.remove('hidden');
        setTimeout(function () { $('#lib-import-text').focus(); }, 60);
    }

    function closeLibraryImport() {
        $('#library-modal').classList.add('hidden');
    }

    function submitLibraryImport() {
        var text = $('#lib-import-text').value;
        if (!text.trim()) {
            toast(t('tt.libNeedText'), 'warn');
            return;
        }
        var btn = $('#btn-lib-import-run');
        btn.disabled = true;
        apiSend('POST', '/api/library/import', { text: text }).then(function (res) {
            var msg = t('tt.libImportToast', [(res.added || 0), (res.skipped || 0)]);
            if (res.invalid) msg += ' · ' + t('tt.libInvalid', res.invalid);
            toast(msg, (res.added || 0) ? 'ok' : 'warn');
            if (res.added) {
                $('#lib-import-text').value = '';
                closeLibraryImport();
            }
            return reloadLibrary();
        }).catch(function (err) {
            toast(err.message, 'error');
        }).finally(function () {
            btn.disabled = false;
        });
    }

    function bindLibraryEvents() {
        $('#btn-lib-upload').addEventListener('click', openLibraryImport);
        $('#btn-cancel-lib-import').addEventListener('click', closeLibraryImport);
        $('#library-modal').addEventListener('mousedown', function (e) {
            if (e.target === this) closeLibraryImport();
        });
        $('#btn-lib-import-run').addEventListener('click', submitLibraryImport);
    }

    // ═══════════════════════════════════════
    //  权威头条流
    // ═══════════════════════════════════════

    function renderStream(animate) {
        var box = $('#auth-stream');
        var sub = $('#auth-subtitle');
        if (sub) sub.textContent = t('tt.authSubtitle', 24);

        var items = (State.stream && State.stream.items) || [];
        if (!items.length) {
            box.innerHTML = '<div class="empty-state"><i class="fa-solid fa-newspaper"></i><span>' +
                esc(t('tt.authEmpty')) + '</span></div>';
            return;
        }

        box.innerHTML = items.map(function (item) {
            /**
             * 紧凑时间显示：
             * 今天     → HH:MM:SS
             * 昨天     → 昨日 HH:MM
             * 更早     → MM-DD HH:MM
             * 完整精确值（年月日时分秒）悬停 title 可见。
             */
            var full = compactToFullTime(item.published_at);
            var timeText = smartShortTime(full, item.source_type, item.published_at);
            var isRss = item.source_type === 'rss';
            return (
                '<div class="stream-item' + (animate ? ' fade-item' : '') + (State.selectedKey === item.key ? ' active' : '') + '" data-key="' + esc(item.key) + '">' +
                  '<span class="stream-time" title="' + esc(full || timeText) + '">' + esc(timeText) + '</span>' +
                  '<span class="stream-body">' +
                    '<div class="stream-title">' + markKeywords(item.title) + '</div>' +
                    '<div class="stream-meta">' +
                      '<span class="src-dot' + (isRss ? ' rss' : '') + '"></span>' +
                      '<span>' + esc(item.source_name) + '</span>' +
                      (item.match ? '<span class="match-badge ' + item.match.level + '">' +
                        (item.match.level === 'high' ? '<i class="fa-solid fa-fire"></i> ' : '') +
                        esc(item.match.tag || t('tt.matchMid')) + '</span>' : '') +
                      (item.url ? '<a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="' +
                        esc(t('tt.readOriginal')) + '"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>' : '') +
                    '</div>' +
                  '</span>' +
                '</div>'
            );
        }).join('');

        addFadeItems(box);
    }

    /** 把各种原始时间归一化为 "YYYY-MM-DD HH:MM[:SS]"；解析失败返回 '' */
    function compactToFullTime(raw) {
        raw = (raw == null ? '' : String(raw)).trim();
        if (!raw) return '';
        var s = raw.replace('T', ' ').replace(/(\.\d+)?([+-]\d{2}:\d{2}|Z)$/, '');
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
        if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
            // 仅时分(秒)：热榜条目——补数据日日期
            s = ((State.stream && State.stream.date) || '') + ' ' + (s.length === 5 ? s + ':00' : s);
        }
        return /^\d{4}/.test(s) ? s : '';
    }

    /** 依据当前时刻选择紧凑展示：今天只显时分秒，昨天/更早补最小必要日期 */
    function smartShortTime(full, sourceType, fallbackRaw) {
        if (!full) return fallbackRaw || '--';
        var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(full);
        if (!m) return full;
        var y = m[1], mo = m[2], d = m[3], hh = m[4], mi = m[5], ss = m[6] || '00';
        var today = new Date();
        function pad2(n) { return n < 10 ? '0' + n : '' + n; }
        var tY = today.getFullYear(), tM = pad2(today.getMonth() + 1), tD = pad2(today.getDate());
        if (y === String(tY) && mo === tM && d === tD) {
            return hh + ':' + mi + ':' + ss;                 // 今天：仅时分秒
        }
        var yesterday = new Date(today.getTime() - 86400000);
        if (y === String(yesterday.getFullYear()) && mo === pad2(yesterday.getMonth() + 1) && d === pad2(yesterday.getDate())) {
            return t('tt.yesterday') + ' ' + hh + ':' + mi;  // 昨天
        }
        return mo + '-' + d + ' ' + hh + ':' + mi;           // 更早
    }

    function addFadeItems(box) {
        Array.prototype.forEach.call(box.children, function (child, i) {
            child.style.opacity = '0';
            child.style.transition = 'opacity .35s ease';
            setTimeout(function () { child.style.opacity = ''; }, Math.min(i * 12, 360));
        });
    }

    function bindStreamToggle() {
        $('#auth-interest-only').addEventListener('change', function (e) {
            State.interestOnly = e.target.checked;
            try { localStorage.setItem('trendradar_terminal_interest_only', e.target.checked ? '1' : '0'); } catch (err) {}
            reloadStream(false);
        });
        try {
            if (localStorage.getItem('trendradar_terminal_interest_only') === '1') {
                $('#auth-interest-only').checked = true;
                State.interestOnly = true;
            }
        } catch (err) {}
    }

    // ═══════════════════════════════════════
    //  多平台热榜列
    // ═══════════════════════════════════════

    function renderHotGrid(animate) {
        var grid = $('#hot-grid');
        var groups = (State.hotlists && State.hotlists.platforms) || [];
        var anyItems = groups.some(function (g) { return (g.items || []).length > 0; });

        if (!anyItems) {
            grid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">' +
                '<i class="fa-solid fa-inbox"></i><span>' + esc(t('tt.noDataHint')) + '</span></div>';
            layoutHotGrid();   // 清掉瀑布流痕迹，回退网格态
            return;
        }

        grid.innerHTML = groups.map(function (group) {
            var rows = (group.items || []).map(function (item, i) {
                var matchedLevel = (item.match || {}).level;
                var hasMatch = matchedLevel === 'high' || matchedLevel === 'mid';
                var matchDot = '<span class="mini-match' + (hasMatch ? ' show ' + matchedLevel : '') + '"></span>';
                return (
                    '<div class="hot-row' + (State.selectedKey === item.key ? ' active' : '') + '" data-key="' + esc(item.key) + '">' +
                      matchDot +
                      '<span class="hot-rank hot-r' + (i + 1) + '">' + (i + 1) + '</span>' +
                      '<span class="hot-row-title" title="' + esc(item.title) + '">' + markKeywords(item.title) + '</span>' +
                    '</div>'
                );
            }).join('');
            var body = rows ||
                '<div style="padding:14px 8px;text-align:center;color:var(--text-secondary);font-size:11px;">--</div>';
            return (
                '<div class="glass-card card-pad" style="border-radius:14px;">' +
                  '<div class="hot-col-head">' +
                    '<span class="hot-col-name"><i class="fa-solid fa-rss"></i> ' + esc(group.name) + '</span>' +
                    '<span class="hot-col-count">' + ((group.items || []).length) + '</span>' +
                  '</div>' + body +
                '</div>'
            );
        }).join('');

        layoutHotGrid();
    }

    function renderHotUpdated(fetchedAt) {
        var el = $('#hot-updated');
        if (!el) return;
        if (!fetchedAt) { el.textContent = ''; return; }
        var time = normalizeClock(fetchedAt);
        el.textContent = t('tt.hotUpdated', time) + hotFreshSuffix(time);
    }

    // ═══════════════════════════════════════
    //  多平台热榜列 · 瀑布流布局
    // ═══════════════════════════════════════
    // 每张平台卡片塞进当前最矮的一列，错落排布；
    // 平台数据量参差时也能紧凑填充，不产生大片空白。

    var HOT_GAP = 12, HOT_MIN_COL = 210;

    function layoutHotGrid() {
        var grid = $('#hot-grid');
        if (!grid) return;
        var cards = Array.prototype.slice.call(grid.children);

        // 空态 / 提示态：回退网格，清掉瀑布流痕迹
        if (!cards.length || (cards.length === 1 && cards[0].classList.contains('empty-state'))) {
            grid.classList.remove('js-masonry');
            grid.style.height = '';
            cards.forEach(resetCardLayout);
            return;
        }

        var avail = grid.clientWidth;
        if (!avail) return;
        var nCols = Math.max(1, Math.floor((avail + HOT_GAP) / (HOT_MIN_COL + HOT_GAP)));
        var colW = (avail - HOT_GAP * (nCols - 1)) / nCols;

        // 先统一列宽并测量高度（此时仍在流内，offsetHeight 为真实内容高度）
        cards.forEach(function (c) { c.style.width = colW + 'px'; });
        var heights = cards.map(function (c) { return c.offsetHeight; });

        // 依次塞进当前最矮的一列，形成错落排布
        var colHeights = new Array(nCols).fill(0);
        cards.forEach(function (c, i) {
            var shortest = 0;
            for (var j = 1; j < nCols; j++) {
                if (colHeights[j] < colHeights[shortest]) shortest = j;
            }
            c.style.position = 'absolute';
            c.style.left = (shortest * (colW + HOT_GAP)) + 'px';
            c.style.top = colHeights[shortest] + 'px';
            c.style.margin = '0';
            colHeights[shortest] += heights[i] + HOT_GAP;
        });

        grid.classList.add('js-masonry');
        grid.style.height = (Math.max.apply(null, colHeights) - HOT_GAP) + 'px';
    }

    function resetCardLayout(c) {
        c.style.width = '';
        c.style.position = '';
        c.style.left = '';
        c.style.top = '';
        c.style.margin = '';
    }

    // ═══════════════════════════════════════
    //  选择与详情面板（基础信息层）
    // ═══════════════════════════════════════

    function selectTopic(key) {
        State.selectedKey = key;
        highlightSelection();

        var indexed = State.itemIndex[key];
        if (!indexed) { resetDetail(); return; }
        renderDetailBase(indexed);
        if (window.TerminalResearch && typeof window.TerminalResearch.ensure === 'function') {
            window.TerminalResearch.ensure(key);
        }
    }

    function highlightSelection() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-key].active'), function (el) {
            el.classList.remove('active');
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-key="' + CSS.escape(State.selectedKey || '') + '"]'), function (el) {
            el.classList.add('active');
        });
    }

    function resetDetail() {
        $('#detail-body').innerHTML =
            '<div class="empty-state"><i class="fa-solid fa-hand-pointer"></i><span>' + esc(t('tt.detailPick')) + '</span></div>';
    }

    function renderDetailBase(indexed) {
        var item = indexed.item;
        var sources = [];
        if (indexed.kind === 'hot') sources.push({ id: '', name: indexed.sourceName, url: item.url });
        else if (indexed.kind === 'stream') sources.push({ id: '', name: item.source_name, url: item.url });
        else sources = item.sources || [];

        var linksHtml = sources.map(function (s) {
            if (!s.url) return '<span class="src-chip">' + esc(s.name) + '</span>';
            return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.name) +
                ' <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px;"></i></a>';
        }).join('<span style="opacity:.4"> · </span>');

        // 头部：标题 + 来源/核心标签行
        var header =
          '<div style="margin-bottom:12px;">' +
            '<div class="detail-h-title" style="margin-bottom:6px;">' + markKeywords(item.title) + '</div>' +
            '<div class="top-meta">' + linksHtml +
              '<span class="ml-auto"></span>' + topicTagsHtml(item) +
            '</div>' +
          '</div>';

        var refsSection =
            '<div class="detail-section">' +
              '<h4><i class="fa-solid fa-book-bookmark"></i>' + esc(t('tt.detailRefs')) + '</h4>' +
              (refsListHtml(sources)) +
            '</div>';

        $('#detail-body').innerHTML =
            header + refsSection +
            researchPlaceholderHtml() +
            notesEditorHtml(item.key) +
            actionButtonsHtml();

        bindNotesEditor(item.key);
        bindDetailActions(item.key);
    }

    function refsListHtml(sources) {
        var rows = sources.filter(Boolean).map(function (s, i) {
            var label = s.title || s.name || ('来源 ' + (i + 1));
            if (!s.url) return '<li>' + esc(label) + '</li>';
            return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a></li>';
        });
        return rows.length ? '<ul class="list-clean">' + rows.join('') + '</ul>' : '<p>--</p>';
    }

    function researchPlaceholderHtml() {
        return (
          '<div id="research-area" class="detail-section">' +
            '<div class="research-generate">' +
              '<i class="fa-solid fa-wand-magic-sparkles research-generate-icon"></i>' +
              '<div class="research-generate-body">' +
                '<div class="research-generate-title">' + esc(t('tt.detailTitle')) + '</div>' +
                '<div class="research-generate-sub">' + esc(t('tt.researchPrompt')) + '</div>' +
              '</div>' +
              '<button class="btn btn-primary" id="btn-research-generate">' +
                '<i class="fa-solid fa-wand-magic-sparkles"></i> ' + esc(t('tt.researchGenerate')) + '</button>' +
            '</div>' +
          '</div>'
        );
    }

    // ── 笔记编辑器 ──

    var notesTimer = null;

    function notesEditorHtml(key) {
        return (
          '<div class="detail-section notes-editor">' +
            '<h4><i class="fa-solid fa-feather-pointed"></i>' + esc(t('tt.detailNotes')) + '</h4>' +
            '<textarea id="notes-area" placeholder="' + esc(t('tt.detailNotes')) + '…"></textarea>' +
            '<div class="notes-status" id="notes-status"></div>' +
          '</div>'
        );
    }

    function bindNotesEditor(key) {
        var area = $('#notes-area');
        var status = $('#notes-status');
        if (!area) return;
        area.value = (window.TerminalNotesCache && window.TerminalNotesCache[key]) || '';

        area.addEventListener('input', function () {
            clearTimeout(notesTimer);
            status.textContent = '…';
            notesTimer = setTimeout(function () {
                apiSend('PUT', '/api/notes', { key: key, notes: area.value }).then(function () {
                    status.textContent = '✓ ' + t('tt.notesSaved');
                    if (!window.TerminalNotesCache) window.TerminalNotesCache = {};
                    window.TerminalNotesCache[key] = area.value;
                }).catch(function (err) {
                    status.textContent = '⚠ ' + err.message;
                });
            }, 700);
        });
    }

    function bindDetailActions(key) {
        var btnExport = $('#btn-detail-export');
        if (btnExport) btnExport.addEventListener('click', function () { exportTopic(key); });
    }

    function actionButtonsHtml() {
        return (
          '<div class="detail-actions">' +
            '<button class="btn btn-ghost btn-mini" id="btn-detail-export"><i class="fa-solid fa-file-arrow-down"></i>' + esc(t('tt.export')) + '</button>' +
          '</div>'
        );
    }

    /** 将已生成的 AI 研判转成 Markdown；未生成过时返回空串 */
    function researchToMarkdown(key) {
        var cached = ResearchCache[key];
        var r = cached && cached.state === 'done' && cached.data && cached.data.research;
        if (!r || !r.summary) return '';

        var md = ['\n## AI 深度研判\n'];
        md.push('### 摘要\n' + r.summary + '\n');

        if ((r.key_elements || []).length) {
            md.push('### 关键要素\n' + r.key_elements.map(function (el) {
                return '- ' + (el.type ? '**' + el.type + '** ' : '') + (el.value || '');
            }).join('\n') + '\n');
        }

        var pills = [];
        if (r.actionability && r.actionability.level) pills.push('可操作性：' + r.actionability.level);
        if (r.exposure_forecast && r.exposure_forecast.tier) pills.push('曝光预判：' + r.exposure_forecast.tier);
        if (r.estimated_minutes != null) pills.push('预估时长：' + r.estimated_minutes + ' 分钟');
        if (pills.length) md.push('### 概览\n- ' + pills.join('\n- ') + '\n');

        if (r.exposure_forecast && r.exposure_forecast.basis) md.push(r.exposure_forecast.basis + '\n');
        if (r.match_explanation) md.push('### 兴趣匹配说明\n' + r.match_explanation + '\n');

        var lists = [
            ['切入点建议', r.angles],
            ['机会分析', r.opportunities],
            ['风险提示', r.risks],
        ];
        lists.forEach(function (item) {
            if (item[1] && item[1].length) {
                md.push('### ' + item[0] + '\n' + item[1].map(function (s) { return '- ' + s; }).join('\n') + '\n');
            }
        });

        return md.join('\n');
    }

    function exportTopic(key) {
        var indexed = State.itemIndex[key];
        if (!indexed) return;
        var item = indexed.item;

        function doExport(notes) {
            var lines = ['# ' + item.title, '',
                '- 来源: ' + (indexed.kind === 'hot' ? indexed.sourceName : (item.source_name || '')),
                item.url ? '- 链接: ' + item.url : '',
                researchToMarkdown(key),
                notes ? ('\n## 我的笔记\n\n' + notes + '\n') : '',
            ];
            var blob = new Blob([lines.filter(Boolean).join('\n')], { type: 'text/markdown;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = (key.substring(0, 8)) + '.md';
            a.click();
            URL.revokeObjectURL(a.href);
            toast('Markdown ✓');
        }

        var cached = window.TerminalNotesCache && window.TerminalNotesCache[key];
        if (cached) { doExport(cached); return; }
        // 本会话未缓存笔记：从后端拉取（/api/research/{key} 附带 notes）
        apiGet('/api/research/' + key).then(function (data) {
            var notes = (data && data.notes) || '';
            if (notes && window.TerminalNotesCache) window.TerminalNotesCache[key] = notes;
            doExport(notes);
        }).catch(function () {
            doExport('');
        });
    }

    // ═══════════════════════════════════════
    //  设置弹窗
    // ═══════════════════════════════════════

    var settingsKeywords = [];

    function openSettings() {
        var p = State.profile;
        $('#set-nickname').value = p.nickname || '';
        $('#set-interests').value = p.interests || '';
        settingsKeywords = (p.keywords || []).slice();
        renderTagChips();
        renderPrefGrid();
        $('#settings-modal').classList.remove('hidden');
    }

    function closeSettings() {
        $('#settings-modal').classList.add('hidden');
    }

    function renderTagChips() {
        var box = $('#tag-box');
        Array.prototype.forEach.call(box.querySelectorAll('.tag-chip'), function (el) { el.remove(); });
        settingsKeywords.forEach(function (kw, idx) {
            var chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = esc(kw) +
                '<button class="tag-remove" aria-label="remove">×</button>';
            chip.querySelector('.tag-remove').addEventListener('click', function () {
                settingsKeywords.splice(idx, 1);
                renderTagChips();
            });
            box.insertBefore(chip, $('#tag-input'));
        });
    }

    function prefItemHtml(item, savedPrefs) {
        var on = savedPrefs[item.id];
        if (on === undefined) on = true;   // 未配置默认全开
        return (
          '<label class="pref-item' + (on ? '' : ' off') + '" data-pref-id="' + esc(item.id) + '">' +
            '<span class="toggle-switch"><input type="checkbox" ' + (on ? 'checked' : '') + '/><span class="toggle-slider"></span></span>' +
            esc(item.name) +
          '</label>'
        );
    }

    function renderPrefGrid() {
        var grid = $('#pref-grid');
        var savedPrefs = State.profile.source_prefs || {};
        var platforms = State.bootstrap && State.bootstrap.platforms || [];
        var feeds = State.bootstrap && State.bootstrap.feeds || [];

        var html = '';
        if (platforms.length) {
            html += '<div class="pref-section">' + esc(t('tt.setSourcesPlatforms')) + '</div>';
            html += platforms.map(function (pl) { return prefItemHtml(pl, savedPrefs); }).join('');
        }
        if (feeds.length) {
            html += '<div class="pref-section">' + esc(t('tt.setSourcesFeeds')) + '</div>';
            html += feeds.map(function (fd) { return prefItemHtml(fd, savedPrefs); }).join('');
        }
        grid.innerHTML = html;

        grid.querySelectorAll('.pref-item').forEach(function (label) {
            label.addEventListener('click', function (e) {
                e.preventDefault();
                var cb = label.querySelector('input');
                cb.checked = !cb.checked;
                label.classList.toggle('off', !cb.checked);
            });
        });
    }

    function saveSettings() {
        var payload = {
            nickname: $('#set-nickname').value.trim(),
            keywords: settingsKeywords.slice(),
            interests: $('#set-interests').value.trim(),
            source_prefs: {},
        };
        $('#pref-grid').querySelectorAll('.pref-item').forEach(function (label) {
            payload.source_prefs[label.getAttribute('data-pref-id')] = label.querySelector('input').checked;
        });

        var btn = $('#btn-save-settings');
        btn.disabled = true;
        saveProfile(payload).then(function () {
            return reloadAllData(true);   // 保存后立即按新数据源偏好刷新热榜与头条流
        }).catch(function (err) {
            toast(err.message, 'warn');
        }).finally(function () {
            btn.disabled = false;
            closeSettings();
        });
    }

    /**
     * 保存个性化配置；若服务端返回 task_id 则开始轮询并在完成后刷新 TOP10。
     */
    function saveProfile(payload) {
        return apiSend('POST', '/api/profile', payload).then(function (result) {
            State.profile = result.profile;
            renderNickname(result.profile.nickname);
            if (State.bootstrap) State.bootstrap.nickname = result.profile.nickname;
            renderKeywordsHint();

            if (result.task_id) {
                State.activeTaskId = result.task_id;
                toast(t('tt.savedToast'), 'warn');
                renderTop10();
                pollTask(result.task_id,
                    function () {
                        State.activeTaskId = null;
                        reloadTop10().then(function () { toast('TOP10 ✓'); });
                    },
                    function (err) {
                        State.activeTaskId = null;
                        renderTop10();
                        toast(err.message, 'error');
                    });
            } else {
                toast('✓');
            }
            return result;
        });
    }

    function renderKeywordsHint() { /* 关键词仅用于标题高亮（markKeywords），无需额外渲染 */ }

    function bindSettingsInput() {
        var input = $('#tag-input');
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var value = input.value.trim();
                if (value && settingsKeywords.indexOf(value) < 0) {
                    settingsKeywords.push(value);
                    renderTagChips();
                }
                input.value = '';
            } else if (e.key === 'Backspace' && !input.value && settingsKeywords.length) {
                settingsKeywords.pop();
                renderTagChips();
            }
        });
        $('#tag-box').addEventListener('click', function (e) {
            if (e.target === this) input.focus();
        });
        $('#btn-save-settings').addEventListener('click', saveSettings);
    }

    // ═══════════════════════════════════════
    //  AI 关键词：从兴趣描述生成 / 从文本抽取
    // ═══════════════════════════════════════

    /** 把 AI 抽出的词合并进设置关键词（保留手动添加的词，去重），并重绘 chips */
    function mergeSettingsKeywords(newKws) {
        var existing = settingsKeywords.map(function (k) { return String(k || '').trim().toLowerCase(); });
        (newKws || []).forEach(function (kw) {
            kw = String(kw || '').trim();
            if (kw && existing.indexOf(kw.toLowerCase()) < 0) {
                settingsKeywords.push(kw);
                existing.push(kw.toLowerCase());
            }
        });
        renderTagChips();
    }

    /** 切换 AI 抽取按钮的 loading 状态（spinner + 文案），并防止重复点击 */
    function setKeywordBtnBusy(btn, busy) {
        if (!btn) return;
        if (busy) {
            btn.dataset.restoreLabel = btn.textContent;   // 记住原标题，便于恢复
            btn.disabled = true;
            btn.classList.add('kw-busy');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span> ' + esc(t('tt.kwExtractBusy')) + '</span>';
        } else {
            btn.disabled = false;
            btn.classList.remove('kw-busy');
            if (btn.dataset.restoreLabel !== undefined) {
                btn.textContent = btn.dataset.restoreLabel;
                delete btn.dataset.restoreLabel;
            }
        }
    }

    /** 调后端抽取接口；仅合并进设置关键词，不自动保存（用户点保存才提交） */
    function callKeywordExtract(text, btn, onOk) {
        setKeywordBtnBusy(btn, true);
        apiSend('POST', '/api/keywords/extract', { text: text }).then(function (data) {
            var list = data.keywords || [];
            mergeSettingsKeywords(list);
            if (onOk) onOk();
            toast(list.length ? t('tt.kwMerged', list.length) : t('tt.kwNoResult'),
                  list.length ? 'ok' : 'warn');
        }).catch(function (err) {
            toast(err.message, 'error');
        }).finally(function () {
            setKeywordBtnBusy(btn, false);
        });
    }

    function extractFromInterests() {
        var text = $('#set-interests').value.trim();
        if (!text) { toast(t('tt.kwNeedInterests'), 'warn'); return; }
        callKeywordExtract(text, $('#btn-kw-from-interests'));
    }

    function extractFromText() {
        var ta = $('#kw-extract-text');
        var text = ta.value.trim();
        if (!text) { toast(t('tt.kwNeedText'), 'warn'); return; }
        callKeywordExtract(text, $('#btn-kw-extract-run'), function () { ta.value = ''; });
    }

    function bindKeywordAi() {
        var btnInterests = $('#btn-kw-from-interests');
        var btnToggle = $('#btn-kw-toggle-extract');
        var btnRun = $('#btn-kw-extract-run');
        if (btnInterests) btnInterests.addEventListener('click', extractFromInterests);
        if (btnToggle) btnToggle.addEventListener('click', function () {
            $('#kw-extract-box').classList.toggle('hidden');
        });
        if (btnRun) btnRun.addEventListener('click', extractFromText);
    }

    // ═══════════════════════════════════════
    //  深度研判加载（M4）
    // ═══════════════════════════════════════

    var ResearchCache = {};   // key -> {state:'loading'|'done', data}

    window.TerminalResearch = {
        ensure: function (key) {
            if (!key || !/^([0-9a-f]{32})$/.test(key)) {
                // key 形如 uuid 时（部分本地场景）直接展示基础信息即可
                return;
            }
            if (ResearchCache[key] && ResearchCache[key].state === 'done') {
                renderResearch(ResearchCache[key].data);
                return;
            }
            if (ResearchCache[key] && ResearchCache[key].state === 'loading') return;
            // 本会话未缓存：先查后端是否已有生成过的研判（跨会话持久化），有则直接展示，无则显示「生成研判」
            apiGet('/api/research/' + key).then(function (data) {
                if (data && data.cached && data.research && data.research.summary) {
                    finishResearch(key, data);
                } else {
                    bindResearchGenerate(key);
                }
            }).catch(function () {
                bindResearchGenerate(key);
            });
        },
        refresh: function (key) {
            delete ResearchCache[key];
            requestResearch(key, true);
        },
    };

    function bindResearchGenerate(key) {
        var btn = $('#btn-research-generate');
        if (!btn) return;
        btn.addEventListener('click', function () {
            requestResearch(key);
        });
    }

    function requestResearch(key, refresh) {
        ResearchCache[key] = { state: 'loading' };
        renderResearchSkeleton();

        apiSend('POST', '/api/research', { key: key, refresh: refresh ? true : undefined }).then(function (result) {
            if (result.cached) {
                finishResearch(key, { cached: true, state: 'done', research: result.research, notes: result.notes });
                return;
            }
            State.activeResearchTask = result.task_id;
            pollTask(result.task_id, function () {
                delete State.activeResearchTask;
                apiGet('/api/research/' + key).then(function (data) {
                    finishResearch(key, data);
                }).catch(function (err) { failResearch(key, err.message); });
            }, function (err) {
                delete State.activeResearchTask;
                failResearch(key, err.message);
            });
        }).catch(function (err) {
            ResearchCache[key] = null;
            failResearch(key, err.message);
        });
    }

    function renderResearchSkeleton() {
        var area = $('#research-area');
        if (!area) return;
        area.innerHTML =
            '<h4><i class="fa-solid fa-wand-magic-sparkles"></i>' + esc(t('tt.detailTitle')) + '</h4>' +
            '<div class="loading-skel"></div><div class="loading-skel" style="width:86%"></div><div class="loading-skel" style="width:92%"></div>' +
            '<div class="empty-state"><i class="fa-solid fa-hourglass-half"></i><span>' +
            esc(t('tt.researchLoading')) + '</span></div>';
    }

    function failResearch(key, message) {
        ResearchCache[key] = null;
        var area = $('#research-area');
        if (!area || State.selectedKey !== key) return;
        var isUnavailable = message.indexOf('api_key') >= 0 || message.indexOf('AI 服务不可用') >= 0;
        area.innerHTML =
            '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><span>' +
            esc(isUnavailable ? t('tt.researchUnavailable') : t('tt.researchError', message)) +
            '</span><button class="btn btn-ghost btn-mini" id="btn-research-retry" style="margin-top:8px;">' +
            esc(t('tt.retry')) + '</button></div>';
        var retry = $('#btn-research-retry');
        if (retry) retry.addEventListener('click', function () { requestResearch(key); });
    }

    function finishResearch(key, data) {
        ResearchCache[key] = { state: 'done', data: data };
        if (State.selectedKey === key) renderResearch(data);
    }

    function renderResearch(data) {
        var area = $('#research-area');
        if (!area) return;

        var r = (data && data.research) || {};
        if (!r.summary) {
            area.innerHTML = '';
            return;
        }

        // 首次拿到服务端笔记时回填缓存
        if (data && data.notes && !(window.TerminalNotesCache && window.TerminalNotesCache[State.selectedKey])) {
            if (!window.TerminalNotesCache) window.TerminalNotesCache = {};
            window.TerminalNotesCache[State.selectedKey] = data.notes;
            var ta = $('#notes-area');
            var statusEl = $('#notes-status');
            if (ta && !ta.value) ta.value = data.notes;
            if (statusEl && data.notes) statusEl.textContent = '';
        }

        var html = '';

        html +=
            '<div class="detail-section"><h4><i class="fa-solid fa-align-left"></i>' + esc(t('tt.detailSummary')) + '</h4>' +
            '<p>' + esc(r.summary) + '</p></div>';

        if ((r.key_elements || []).length) {
            html += '<div class="detail-section"><h4><i class="fa-solid fa-puzzle-piece"></i>' + esc(t('tt.detailElements')) + '</h4>' +
                '<div class="kv-chips">' + r.key_elements.map(function (el) {
                    return '<span class="kv-chip"><b>' + esc(el.type) + '</b>' + esc(el.value) + '</span>';
                }).join('') + '</div></div>';
        }

        html += '<div class="kv-chips" style="margin-bottom:12px;">';
        if (r.actionability && r.actionability.level) {
            html += '<span class="level-pill L' + esc(r.actionability.level) + '">' +
                '<i class="fa-solid fa-bolt"></i>' + esc(t('tt.detailAction')) + ' · ' + esc(r.actionability.level) + '</span>';
        }
        if (r.exposure_forecast && r.exposure_forecast.tier) {
            html += '<span class="level-pill"><i class="fa-solid fa-chart-line"></i>' + esc(t('tt.detailExposure')) + ' · ' + esc(r.exposure_forecast.tier) + '</span>';
        }
        if (r.estimated_minutes != null) {
            html += '<span class="level-pill"><i class="fa-regular fa-clock"></i>' + esc(t('tt.detailHours')) + ' · ' + esc(r.estimated_minutes) + ' ' + esc(t('tt.detailMinutesUnit')) + '</span>';
        }
        html += '</div>';

        if (r.exposure_forecast && r.exposure_forecast.basis) {
            html += '<p class="form-hint" style="margin-bottom:10px;">' + esc(r.exposure_forecast.basis) + '</p>';
        }

        if (r.match_explanation) {
            html += '<div class="detail-section"><h4><i class="fa-brands fa-searchengin"></i>' + esc(t('tt.detailMatchWhy')) + '</h4>' +
                '<p>' + esc(r.match_explanation) + '</p></div>';
        }

        html += listSectionHtml('tt.detailAngles', 'fa-route', r.angles) +
            listSectionHtml('tt.detailOpps', 'fa-lightbulb', r.opportunities) +
            listSectionHtml('tt.detailRisks', 'fa-triangle-exclamation', r.risks);

        html +=
            '<div class="detail-section" style="display:flex;justify-content:flex-end;">' +
              '<button class="btn btn-ghost btn-mini" id="btn-research-refresh">' +
                '<i class="fa-solid fa-rotate"></i>' + esc(t('tt.refreshResearch')) + '</button>' +
            '</div>';

        area.innerHTML = html;

        var refreshBtn = $('#btn-research-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                if (State.selectedKey) window.TerminalResearch.refresh(State.selectedKey);
            });
        }
    }

    function listSectionHtml(labelKey, icon, items) {
        if (!items || !items.length) return '';
        return (
          '<div class="detail-section"><h4><i class="fa-solid ' + icon + '"></i>' + esc(t(labelKey)) + '</h4>' +
          '<ul class="list-clean">' + items.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>'
        );
    }

    // ═══════════════════════════════════════
    //  事件委托 & 启动
    // ═══════════════════════════════════════

    function bindGlobalDelegation() {
        document.body.addEventListener('click', function (e) {
            // 选题库动作按钮（入库）优先于选题选中：按钮在 top-item[data-key] 内部
            var libBtn = e.target.closest('[data-lib]');
            if (libBtn) { handleLibAction(libBtn); return; }
            var topicEl = e.target.closest('[data-key]');
            if (topicEl && !e.target.closest('a')) {
                selectTopic(topicEl.getAttribute('data-key'));
            }
        });
    }

    window.onTerminalLangChange = function () {
        renderStatus(State.bootstrap && State.bootstrap.status);
        renderSourceStats();
        renderMatchStats();
        if (State.stream) renderStream(false);
        if (State.hotlists) {
            renderHotGrid(false);
            renderHotUpdated(State.hotlists.fetched_at);
        }
        if (State.top10) renderTop10();
        renderLibrary();
        if (!State.selectedKey) resetDetail();
    };

    /** 手动触发 TOP10 重新生成 */
    function triggerRescore() {
        if (State.activeTaskId) return;   // 已有打分任务在跑
        return apiSend('POST', '/api/score/run', {}).then(function (result) {
            var tid = result && result.task_id;
            if (!tid) return;
            State.activeTaskId = tid;
            renderTop10();
            pollTask(tid,
                function () {
                    State.activeTaskId = null;
                    reloadTop10().then(function () { toast('TOP10 ✓'); });
                },
                function (err) {
                    State.activeTaskId = null;
                    renderTop10();
                    toast(err.message, 'error');
                });
        }).catch(function (err) {
            toast(err.message, 'error');
        });
    }

    function boot() {
        bindTopbarEvents();
        bindStreamToggle();
        bindSettingsInput();
        bindKeywordAi();
        bindLibraryEvents();
        bindGlobalDelegation();

        // TOP10 手动重新生成
        var rescoreBtn = $('#btn-top10-rescore');
        if (rescoreBtn) rescoreBtn.addEventListener('click', triggerRescore);

        startClock();

        // 窗口缩放后重新排布热榜瀑布流
        var resizeTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(layoutHotGrid, 150);
        });

        loadBootstrap()
            .then(loadProfile)
            .then(function () {
                renderStatus(State.bootstrap && State.bootstrap.status);
                return reloadAllData(false);
            })
            .then(reloadTop10)
            .then(reloadLibrary)
            .catch(function (err) {
                console.error(err);
                toast(err.message, 'error');
            });

        // 每 5 分钟静默刷新在榜数据与头条流
        setInterval(function () { reloadAllData(true); }, 5 * 60 * 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
