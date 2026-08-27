/**
 * 选题终端 i18n - 中英双语文案与引擎
 * 沿用 docs/assets/i18n.js 的轻量方案，共享 localStorage 键 trendradar_lang
 */
(function () {
    'use strict';

    var STORAGE_KEY_LANG = 'trendradar_lang';
    var currentLang = 'zh';
    var T = { zh: {}, en: {} };

    function add(entries) {
        entries.forEach(function (e) {
            T.zh[e[0]] = e[1];
            T.en[e[0]] = e[2];
        });
    }

    // ═══════════════════════════════════════
    //  顶栏
    // ═══════════════════════════════════════
    add([
        ['tt.brand', '选题终端', 'Topic Terminal'],
        ['tt.titleSuffix', '· 选题终端（TOPIC TERMINAL v1.0）', '· Topic Terminal v1.0'],
        ['tt.editName', '点击修改名称', 'Click to rename'],
        ['tt.namePlaceholder', '输入你的昵称', 'Enter your nickname'],
        ['tt.langSwitch', 'EN', '中'],
        ['tt.statusOk', '数据源正常', 'All sources healthy'],
        ['tt.statusWarn', '部分数据源异常', 'Some sources degraded'],
        ['tt.statusDown', '数据源离线 / 长时间未更新', 'Sources offline or stale'],
        ['tt.settings', '设置', 'Settings'],
    ]);

    // ═══════════════════════════════════════
    //  TOP10 区
    // ═══════════════════════════════════════
    add([
        ['tt.top10Title', '今日综合选题 TOP10', "Today's Top 10 Topics"],
        ['tt.top10Subtitle', '全网热点 × 你的兴趣 → AI 生成的专属选题榜', 'All-network trends × your interests → your personal topic list'],
        ['tt.top10Empty', '尚未生成专属选题榜。点击右上角 ⚙️ 设置兴趣描述，或等待抓取完成后自动打分。', 'No personalized list yet. Set your interests via ⚙️ Settings, or wait for the next crawl to be scored.'],
        ['tt.top10Generating', 'AI 正在结合你的兴趣重新打分…', 'AI is rescoring topics against your interests…'],
        ['tt.top10Progress', '已处理 {0}/{1}', '{0}/{1} processed'],
        ['tt.score', '综合评分', 'Score'],
        ['tt.matchHigh', '高匹配', 'High match'],
        ['tt.matchMid', '中匹配', 'Mid match'],
        ['tt.matchLow', '低匹配', 'Low match'],
        ['tt.sources', '来源', 'Sources'],
        ['tt.mergedCount', '{0} 个平台同题报道', 'Covered by {0} platforms'],
        ['tt.stRecommend', '推荐', 'Featured'],
        ['tt.stWatched', '待看', 'To read'],
        ['tt.stDone', '已阅', 'Done'],
        ['tt.stNone', '未标记', 'Unmarked'],
    ]);

    // ═══════════════════════════════════════
    //  权威头条区
    // ═══════════════════════════════════════
    add([
        ['tt.authTitle', '权威新闻源头条', 'Authoritative Headlines'],
        ['tt.authSubtitle', '最近 {0} 小时 · RSS 与财经热榜原始素材池', 'Last {0}h · Raw feed pool of RSS and finance hotlists'],
        ['tt.interestOnly', '仅显示与我兴趣相关', 'Only interest matches'],
        ['tt.authEmpty', '24 小时内暂无头条数据。', 'No headlines in the last 24 hours.'],
        ['tt.readOriginal', '查看原文', 'Read original'],
    ]);

    // ═══════════════════════════════════════
    //  热榜并列区
    // ═══════════════════════════════════════
    add([
        ['tt.hotTitle', '多平台实时热榜', 'Multi-platform Hotlists'],
        ['tt.hotSubtitle', '横向对比各平台原始热榜，绿色为兴趣匹配项', 'Compare raw hotlists side by side; green marks interest matches'],
        ['tt.hotUpdated', '更新于 {0}', 'Updated at {0}'],
        ['tt.noDataHint', '今日暂无数据：请确认爬虫已运行（Docker 定时任务或手动触发）。', 'No data yet today: make sure the crawler has run (Docker cron or manual run).'],
        ['tt.showMore', '展开更多', 'Show more'],
        ['tt.showLess', '收起', 'Show less'],
    ]);

    // ═══════════════════════════════════════
    //  详情面板
    // ═══════════════════════════════════════
    add([
        ['tt.detailTitle', '详情研判', 'Research Panel'],
        ['tt.detailPick', '从左侧或中间选择一条选题，这里会展示 AI 研判结果。', 'Select a topic on the left or middle to see its AI research here.'],
        ['tt.detailSummary', '选题摘要', 'Summary'],
        ['tt.detailElements', '关键要素', 'Key Elements'],
        ['tt.detailAction', '可操作性', 'Actionability'],
        ['tt.detailExposure', '曝光预判', 'Exposure Forecast'],
        ['tt.detailHours', '预估时长', 'Estimated Hours'],
        ['tt.detailHoursUnit', '小时', 'hours'],
        ['tt.detailMatchWhy', '为什么推荐给你', 'Why recommended for you'],
        ['tt.detailAngles', '切入点建议', 'Suggested Angles'],
        ['tt.detailOpps', '机会分析', 'Opportunities'],
        ['tt.detailRisks', '风险提示', 'Risks'],
        ['tt.detailRefs', '参考素材', 'References'],
        ['tt.detailNotes', '我的研判笔记', 'My Notes'],
        ['tt.notesSaved', '笔记已保存', 'Notes saved'],
        ['tt.markDone', '标记为已处理', 'Mark as done'],
        ['tt.addWatch', '加入待看', 'Add to reading list'],
        ['tt.export', '导出选题', 'Export'],
        ['tt.researchLoading', 'AI 正在深度研判该选题…（约需十几秒）', 'AI is researching this topic… (about 15s)'],
        ['tt.researchError', '研判生成失败：{0}', 'Research failed: {0}'],
        ['tt.researchUnavailable', 'AI 服务不可用：请在 config.yaml 配置 ai.api_key 后重启终端服务。', 'AI unavailable: configure ai.api_key in config.yaml and restart the terminal service.'],
        ['tt.refreshResearch', '重新生成研判', 'Regenerate research'],
    ]);

    // ═══════════════════════════════════════
    //  设置弹窗
    // ═══════════════════════════════════════
    add([
        ['tt.setTitle', '个性化设置', 'Personalization'],
        ['tt.setNickname', '我的昵称', 'Nickname'],
        ['tt.setNicknameHint', '显示在顶栏，默认「路口大爷」', 'Shown in the top bar, default “路口大爷”'],
        ['tt.setKeywords', '关注关键词', 'Watch Keywords'],
        ['tt.setKeywordsHint', '回车添加标签；关键词用于页面快速高亮与过滤', 'Press Enter to add tags; keywords highlight/filter items quickly'],
        ['tt.setInterests', '兴趣描述', 'Interest Description'],
        ['tt.setInterestsHint', '用自然语言描述你关注的方向，保存后 AI 会立即据此重新生成选题榜', 'Describe your focus in plain language; saving triggers an immediate AI rescore'],
        ['tt.setInterestsPlaceholder', '例如：我是财经记者，主要关注宏观经济政策、央行动向、资本市场波动……', 'e.g. I am a finance reporter focusing on macro policy, central banks, capital markets…'],
        ['tt.setSources', '数据源偏好', 'Source Preferences'],
        ['tt.setSourcesHint', '仅控制本页展示范围，不改变采集配置', 'Filters this page only; does not change crawler config'],
        ['tt.saveBtn', '保存并重新生成选题', 'Save & rescore'],
        ['tt.cancelBtn', '取消', 'Cancel'],
        ['tt.savedToast', '设置已保存，正在重新生成选题榜…', 'Settings saved. Rescoring started…'],
        ['tt.keywordsQuick', '关键词快速高亮', 'Keyword quick highlight'],
    ]);

    // ═══════════════════════════════════════
    //  杂项
    // ═══════════════════════════════════════
    add([
        ['tt.week.Mon', '周一', 'Mon'], ['tt.week.Tue', '周二', 'Tue'],
        ['tt.week.Wed', '周三', 'Wed'], ['tt.week.Thu', '周四', 'Thu'],
        ['tt.week.Fri', '周五', 'Fri'], ['tt.week.Sat', '周六', 'Sat'],
        ['tt.week.Sun', '周日', 'Sun'],
        ['tt.loadFail', '加载失败：{0}', 'Load failed: {0}'],
        ['tt.retry', '重试', 'Retry'],
        ['tt.justNow', '刚刚', 'just now'],
        ['tt.minAgo', '{0} 分钟前', '{0} min ago'],
        ['tt.yesterday', '昨日', 'Yesterday'],
    ]);

    // ═══════════════════════════════════════
    //  Engine（对齐 docs 版）
    // ═══════════════════════════════════════

    window.t = function (key, replacements) {
        var dict = T[currentLang] || T.zh;
        var text = dict[key] || T.zh[key] || key;
        if (replacements !== undefined) {
            if (typeof replacements === 'string' || typeof replacements === 'number') {
                text = text.replace('{0}', replacements);
            } else if (Array.isArray(replacements)) {
                replacements.forEach(function (val, i) {
                    text = text.replace('{' + i + '}', val);
                });
            }
        }
        return text;
    };

    window.getTermLang = function () {
        return currentLang;
    };

    window.switchTermLang = function (lang) {
        if (lang !== 'zh' && lang !== 'en') return;
        currentLang = lang;
        try { localStorage.setItem(STORAGE_KEY_LANG, lang); } catch (e) { /* ignore */ }
        document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
        applyI18nStatic();
        updateLangToggleUI();
        if (typeof window.onTerminalLangChange === 'function') window.onTerminalLangChange();
    };

    function applyI18nStatic(root) {
        var scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            var text = window.t(key);
            if (text !== key) el.textContent = text;
        });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-placeholder');
            var text = window.t(key);
            if (text !== key) el.placeholder = text;
        });
        scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-title');
            var text = window.t(key);
            if (text !== key) el.title = text;
        });
    }

    function updateLangToggleUI() {
        var label = document.getElementById('lang-toggle-label');
        if (label) label.textContent = currentLang === 'zh' ? 'EN' : '中';
    }

    (function init() {
        var saved = null;
        try { saved = localStorage.getItem(STORAGE_KEY_LANG); } catch (e) { /* ignore */ }
        if (saved === 'zh' || saved === 'en') {
            currentLang = saved;
        } else {
            currentLang = (navigator.language || '').indexOf('zh') === 0 ? 'zh' : 'en';
        }
        document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                applyI18nStatic();
                updateLangToggleUI();
            });
        } else {
            applyI18nStatic();
            updateLangToggleUI();
        }
    })();
})();
