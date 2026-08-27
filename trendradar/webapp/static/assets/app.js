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
    };

    window.TerminalApp = { state: State };

    // ═══════════════════════════════════════
    //  数据加载
    // ═══════════════════════════════════════

    function loadBootstrap() {
        return apiGet('/api/bootstrap').then(function (data) {
            State.bootstrap = data;
            renderVersion(data.version);
            renderStatus(data.status);
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

    function reloadHotlists(silent) {
        return apiGet('/api/hotlists?limit=30').then(function (data) {
            State.hotlists = data;
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

    function renderVersion(version) {
        var badge = $('#version-badge');
        if (badge && version) badge.textContent = 'v' + version;
    }

    function renderStatus(status) {
        var dot = $('#status-dot');
        var wrap = $('#status-wrap');
        var label = $('#status-label');
        if (!dot || !status) return;
        dot.className = 'status-dot ' + status.level;

        var map = { green: 'tt.statusOk', yellow: 'tt.statusWarn', red: 'tt.statusDown' };
        label.textContent = t(map[status.level] || 'tt.statusWarn');

        var detail = [];
        if (status.platform_total) detail.push('热榜 ' + status.platform_ok + '/' + status.platform_total);
        if (status.rss_total) detail.push('RSS ' + status.rss_ok + '/' + status.rss_total);
        if (status.last_crawl) detail.push(t('tt.hotUpdated', status.last_crawl));
        if (status.last_available_date && status.last_available_date !== status.date) {
            detail.push('最新数据日: ' + status.last_available_date);
        }
        wrap.setAttribute('title', label.textContent + '\n' + detail.join('\n'));
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
            var value = input.value.trim();
            input.remove();
            delete span.dataset.editing;
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
            if (e.key === 'Enter') commit(true);
            if (e.key === 'Escape') commit(false);
        });
        input.addEventListener('blur', function () { commit(false); });
    }

    // ═══════════════════════════════════════
    //  TOP10 列表
    // ═══════════════════════════════════════

    function renderTop10() {
        var listEl = $('#top10-list');
        var progressEl = $('#top10-progress');
        var items = (State.top10 && State.top10.items) || [];

        if (State.activeTaskId) {
            progressEl.innerHTML =
                '<div class="task-banner"><i class="fa-solid fa-wand-magic-sparkles fa-spin"></i>' +
                '<span id="top10-task-label">' + esc(t('tt.top10Generating')) + '</span></div>';
        } else {
            progressEl.innerHTML = '';
        }

        if (!items.length) {
            listEl.innerHTML =
                '<div class="empty-state"><i class="fa-solid fa-crown"></i><span>' +
                esc(t('tt.top10Empty')) + '</span></div>';
            return;
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
                      (item.event_type ? '<span class="badge-tag badge-type">' + esc(item.event_type) + '</span>' : '') +
                      '<span class="match-badge ' + matchCls + '" title="' + esc(t('tt.matchHigh')) + '">' + matchIcon + Math.round((item.match_score || 0) * 100) + '%</span>' +
                    '</span>' +
                    '<span class="top-meta">' + srcChips +
                      ((item.merged_count || 1) > 1 ? '<span>' + esc(t('tt.mergedCount', item.merged_count)) + '</span>' : '') +
                      '<span class="ml-auto"></span>' + statusSegHtml(item.key, item.topic_status) +
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

    function statusSegHtml(key, current) {
        function seg(value, labelKey) {
            var active = current === value ? ' seg-btn.active-' + value : '';
            return '<button class="seg-btn' + active + '" data-status-key="' + esc(key) + '" data-status="' + value + '">' +
                esc(t(labelKey)) + '</button>';
        }
        return '<span class="seg-group">' +
            seg('recommended', 'tt.stRecommend') +
            seg('watched', 'tt.stWatched') +
            seg('done', 'tt.stDone') +
            '</span>';
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
            // 完整时间：YYYY-MM-DD HH:MM(:SS)；热榜条目仅有 HH:MM 时补当天日期
            var raw = item.published_at ? String(item.published_at).trim() : '';
            var timeText;
            if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
                timeText = raw.replace('T', ' ').replace(/(\.\d+)?([+-]\d{2}:\d{2}|Z)$/, '');
                if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timeText)) timeText += ':00';
            } else if (/^\d{2}:\d{2}$/.test(raw)) {
                timeText = (State.stream && State.stream.date ? State.stream.date + ' ' : '') + raw;
            } else {
                timeText = raw || '--';
            }
            var isRss = item.source_type === 'rss';
            return (
                '<div class="stream-item' + (animate ? ' fade-item' : '') + (State.selectedKey === item.key ? ' active' : '') + '" data-key="' + esc(item.key) + '">' +
                  '<span class="stream-time">' + esc(timeText) + '</span>' +
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
            return;
        }

        grid.innerHTML = groups.map(function (group) {
            var rows = (group.items || []).map(function (item, i) {
                var matchedLevel = (item.match || {}).level;
                var hasMatch = matchedLevel === 'high' || matchedLevel === 'mid';
                var matchDot = '<span class="mini-match' + (hasMatch ? ' show ' + matchedLevel : '') + '"></span>';
                var statusMark = item.topic_status ? ' <i class="fa-solid fa-bookmark" style="color:var(--brand-a)"></i>' : '';
                return (
                    '<div class="hot-row' + (State.selectedKey === item.key ? ' active' : '') + '" data-key="' + esc(item.key) + '">' +
                      matchDot +
                      '<span class="hot-rank hot-r' + (i + 1) + '">' + (i + 1) + '</span>' +
                      '<span class="hot-row-title" title="' + esc(item.title) + '">' + markKeywords(item.title) + statusMark + '</span>' +
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
    }

    function renderHotUpdated(fetchedAt) {
        var el = $('#hot-updated');
        if (!el) return;
        el.textContent = fetchedAt ? t('tt.hotUpdated', fetchedAt) : '';
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

        // 头部：标题 + 来源/状态行
        var header =
          '<div style="margin-bottom:12px;">' +
            '<div class="detail-h-title" style="margin-bottom:6px;">' + markKeywords(item.title) + '</div>' +
            '<div class="top-meta">' + linksHtml +
              '<span class="ml-auto"></span>' + statusSegHtml(item.key, currentStatusOf(item.key)) +
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
            actionButtonsHtml(item.key);

        bindNotesEditor(item.key);
        bindDetailActions(item.key);
    }

    function currentStatusOf(key) {
        var found = State.itemIndex[key];
        return (found && found.item && found.item.topic_status) || '';
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
            '<div class="loading-skel"></div><div class="loading-skel" style="width:88%"></div>' +
            '<div class="empty-state"><i class="fa-solid fa-wand-magic-sparkles"></i><span>' +
            esc(t('tt.researchLoading')) + '</span></div>' +
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
        var btnDone = $('#btn-detail-done');
        var btnWatch = $('#btn-detail-watch');
        var btnExport = $('#btn-detail-export');
        if (btnDone) btnDone.addEventListener('click', function () { updateTopicStatus(key, 'done'); });
        if (btnWatch) btnWatch.addEventListener('click', function () { updateTopicStatus(key, 'watched'); });
        if (btnExport) btnExport.addEventListener('click', function () { exportTopic(key); });
    }

    function actionButtonsHtml(key) {
        return (
          '<div class="detail-actions">' +
            '<button class="btn btn-primary btn-mini" id="btn-detail-done"><i class="fa-solid fa-check"></i>' + esc(t('tt.markDone')) + '</button>' +
            '<button class="btn btn-ghost btn-mini" id="btn-detail-watch"><i class="fa-solid fa-bookmark"></i>' + esc(t('tt.addWatch')) + '</button>' +
            '<button class="btn btn-ghost btn-mini" id="btn-detail-export"><i class="fa-solid fa-file-arrow-down"></i>' + esc(t('tt.export')) + '</button>' +
          '</div>'
        );
    }

    function exportTopic(key) {
        var indexed = State.itemIndex[key];
        if (!indexed) return;
        var item = indexed.item;
        var lines = ['# ' + item.title, '',
            '- 来源: ' + (indexed.kind === 'hot' ? indexed.sourceName : (item.source_name || '')),
            item.url ? '- 链接: ' + item.url : '',
            (window.TerminalNotesCache && window.TerminalNotesCache[key]) ?
                ('\n## 我的笔记\n\n' + window.TerminalNotesCache[key] + '\n') : '',
        ];
        var blob = new Blob([lines.filter(Boolean).join('\n')], { type: 'text/markdown;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (key.substring(0, 8)) + '.md';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Markdown ✓');
    }

    // ── 状态更新 ──

    function setTopicStatusEverywhere(key, status) {
        var normalized = status === 'none' || !status ? '' : status;
        (State.hotlists && State.hotlists.platforms || []).forEach(function (g) {
            (g.items || []).forEach(function (it) { if (it.key === key) it.topic_status = normalized; });
        });
        (State.stream && State.stream.items || []).forEach(function (it) { if (it.key === key) it.topic_status = normalized; });
        State.top10 && (State.top10.items || []).forEach(function (it) { if (it.key === key) it.topic_status = normalized; });
    }

    function updateTopicStatus(key, status) {
        return apiSend('POST', '/api/topic-status', { key: key, status: status }).then(function () {
            setTopicStatusEverywhere(key, status);
            renderHotGrid(false);
            if (State.top10) renderTop10();
            // 同步详情面板中的状态按钮
            var indexed = State.itemIndex[key];
            if (indexed && State.selectedKey === key) selectTopic(key);
            return null;
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

    function renderPrefGrid() {
        var grid = $('#pref-grid');
        var prefs = [];
        (State.bootstrap && State.bootstrap.platforms || []).forEach(function (pl) { prefs.push(pl); });
        var savedPrefs = State.profile.source_prefs || {};

        grid.innerHTML = prefs.map(function (pl) {
            var on = savedPrefs[pl.id];
            if (on === undefined) on = true;   // 未配置默认全开
            return (
              '<label class="pref-item' + (on ? '' : ' off') + '" data-pref-id="' + esc(pl.id) + '">' +
                '<span class="toggle-switch"><input type="checkbox" ' + (on ? 'checked' : '') + '/><span class="toggle-slider"></span></span>' +
                esc(pl.name) +
              '</label>'
            );
        }).join('');

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
        saveProfile(payload).catch(function (err) {
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
            requestResearch(key);
        },
        refresh: function (key) {
            delete ResearchCache[key];
            requestResearch(key, true);
        },
    };

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
        if (r.estimated_hours != null) {
            html += '<span class="level-pill"><i class="fa-regular fa-clock"></i>' + esc(t('tt.detailHours')) + ' · ' + esc(r.estimated_hours) + ' ' + esc(t('tt.detailHoursUnit')) + '</span>';
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
            var segBtn = e.target.closest('.seg-btn[data-status-key]');
            if (segBtn) {
                e.stopPropagation();
                var key = segBtn.getAttribute('data-status-key');
                // 点击已激活的状态 → 取消；否则设为新状态
                var wasActive = /active-(recommended|watched|done)/.test(segBtn.className);
                var next = wasActive ? 'none' : segBtn.getAttribute('data-status');
                updateTopicStatus(key, next);
                return;
            }

            var topicEl = e.target.closest('[data-key]');
            if (topicEl && !e.target.closest('a')) {
                selectTopic(topicEl.getAttribute('data-key'));
            }
        });
    }

    window.onTerminalLangChange = function () {
        renderStatus(State.bootstrap && State.bootstrap.status);
        if (State.stream) renderStream(false);
        if (State.hotlists) renderHotGrid(false);
        if (State.top10) renderTop10();
        if (!State.selectedKey) resetDetail();
    };

    function boot() {
        bindTopbarEvents();
        bindStreamToggle();
        bindSettingsInput();
        bindGlobalDelegation();
        startClock();

        loadBootstrap()
            .then(loadProfile)
            .then(function () {
                renderStatus(State.bootstrap && State.bootstrap.status);
                return reloadAllData(false);
            })
            .then(reloadTop10)
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
