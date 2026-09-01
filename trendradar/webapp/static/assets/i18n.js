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
        ['tt.titleSuffix', '· 选题终端', '· TOPIC TERMINAL'],
        ['tt.editName', '点击修改名称', 'Click to rename'],
        ['tt.namePlaceholder', '输入你的昵称', 'Enter your nickname'],
        ['tt.langSwitch', 'EN', '中'],
        ['tt.statusOk', '数据源正常', 'All sources healthy'],
        ['tt.statusWarn', '部分数据源异常', 'Some sources degraded'],
        ['tt.statusDown', '数据源离线 / 长时间未更新', 'Sources offline or stale'],
        ['tt.statusStale', '数据略旧，等待今日抓取', 'Stale data — waiting for today\'s crawl'],
        ['tt.srcStats', '数据源 {0} · 平台 {1} · RSS {2}', 'Sources {0} · Platforms {1} · RSS {2}'],
        ['tt.platform', '平台', 'Platforms'],
        ['tt.matchStats', '热榜命中 {0}/{1} · RSS 命中 {2}/{3}', 'Hotlist {0}/{1} · RSS {2}/{3}'],
        ['tt.settings', '设置', 'Settings'],
    ]);

    // ═══════════════════════════════════════
    //  TOP10 区
    // ═══════════════════════════════════════
    add([
        ['tt.top10Title', '今日综合选题 TOP10', "Today's Top 10 Topics"],
        ['tt.top10Subtitle', '全网热点 × 你的兴趣 → AI 生成的专属选题榜', 'All-network trends × your interests → your personal topic list'],
        ['tt.top10Gen', '生成于 {0}', 'Generated {0}'],
        ['tt.rescore', '重新生成选题', 'Regenerate topics'],
        ['tt.top10Empty', '尚未生成专属选题榜。点击右上角 ⚙️ 设置兴趣描述，或等待抓取完成后自动打分。', 'No personalized list yet. Set your interests via ⚙️ Settings, or wait for the next crawl to be scored.'],
        ['tt.top10Generating', 'AI 正在结合你的兴趣重新打分…', 'AI is rescoring topics against your interests…'],
        ['tt.top10Progress', '已处理 {0}/{1}', '{0}/{1} processed'],
        ['tt.score', '综合评分', 'Score'],
        ['tt.matchHigh', '高匹配', 'High match'],
        ['tt.matchMid', '中匹配', 'Mid match'],
        ['tt.matchLow', '低匹配', 'Low match'],
        ['tt.sources', '来源', 'Sources'],
        ['tt.mergedCount', '{0} 个平台同题报道', 'Covered by {0} platforms'],
    ]);

    // ═══════════════════════════════════════
    //  权威头条区
    // ═══════════════════════════════════════
    add([
        ['tt.authTitle', '权威新闻源头条', 'Authoritative Headlines'],
        ['tt.authSubtitle', '最近 {0} 小时 · RSS 与权威媒体热榜原始素材池', 'Last {0}h · Raw feed pool of RSS and authoritative hotlists'],
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
        ['tt.detailHours', '预估时长', 'Estimated Duration'],
        ['tt.detailMinutesUnit', '分钟', 'min'],
        ['tt.detailMatchWhy', '为什么推荐给你', 'Why recommended for you'],
        ['tt.detailAngles', '切入点建议', 'Suggested Angles'],
        ['tt.detailOpps', '机会分析', 'Opportunities'],
        ['tt.detailRisks', '风险提示', 'Risks'],
        ['tt.detailRefs', '参考素材', 'References'],
        ['tt.detailNotes', '我的研判笔记', 'My Notes'],
        ['tt.notesSaved', '笔记已保存', 'Notes saved'],
        ['tt.export', '导出选题', 'Export'],
        ['tt.researchLoading', 'AI 正在深度研判该选题…（约需十几秒）', 'AI is researching this topic… (about 15s)'],
        ['tt.researchError', '研判生成失败：{0}', 'Research failed: {0}'],
        ['tt.researchUnavailable', 'AI 服务不可用：请在 config.yaml 配置 ai.api_key 后重启终端服务。', 'AI unavailable: configure ai.api_key in config.yaml and restart the terminal service.'],
        ['tt.refreshResearch', '重新生成研判', 'Regenerate research'],
        ['tt.researchGenerate', '生成研判', 'Generate research'],
        ['tt.researchPrompt', 'AI 深度研判需调用一次大模型，点击下方按钮生成', 'AI research costs one model call — generate now'],
    ]);

    // ═══════════════════════════════════════
    //  设置弹窗
    // ═══════════════════════════════════════
    add([
        ['tt.setTitle', '个性化设置', 'Personalization'],
        ['tt.setNickname', '我的昵称', 'Nickname'],
        ['tt.setNicknameHint', '显示在顶栏，默认「隔岸观火」', 'Shown in the top bar, default “隔岸观火”'],
        ['tt.setKeywords', '关注关键词', 'Watch Keywords'],
        ['tt.setKeywordsHint', '回车添加标签；关键词用于页面快速高亮与过滤，保存后同步到 cron 频率词配置', 'Press Enter to add tags; keywords highlight/filter items and sync to cron keyword config on save'],
        ['tt.kwFromInterests', '从兴趣描述生成', 'Generate from interests'],
        ['tt.kwToggleExtract', '从文本抽取…', 'Extract from text…'],
        ['tt.kwExtractPlaceholder', '粘贴新闻 / 笔记 / 描述，AI 抽取关注关键词…', 'Paste a passage; AI extracts watch keywords…'],
        ['tt.kwExtractRun', '提取关键词', 'Extract keywords'],
        ['tt.kwExtractBusy', 'AI 提取中…', 'Extracting…'],
        ['tt.kwExtractHint', '结果合并到上方标签（去重），点「保存并重新生成选题」后写入 cron 关键词', 'Merged into tags above (dedup); saved to cron keywords on “Save & rescore”'],
        ['tt.kwNeedInterests', '请先填写兴趣描述', 'Fill in interest description first'],
        ['tt.kwNeedText', '请先粘贴要抽取的文本', 'Paste some text to extract from first'],
        ['tt.kwMerged', '已合并 {0} 个关键词', 'Merged {0} keywords'],
        ['tt.kwNoResult', 'AI 未抽取到有效关键词', 'AI found no valid keywords'],
        ['tt.setInterests', '兴趣描述', 'Interest Description'],
        ['tt.setInterestsHint', '用自然语言描述你关注的方向，保存后 AI 会立即据此重新生成选题榜', 'Describe your focus in plain language; saving triggers an immediate AI rescore'],
        ['tt.setInterestsPlaceholder', '例如：我是财经记者，主要关注宏观经济政策、央行动向、资本市场波动……', 'e.g. I am a finance reporter focusing on macro policy, central banks, capital markets…'],
        ['tt.setSources', '数据源偏好', 'Source Preferences'],
        ['tt.setSourcesHint', '取消后对应数据源在本页热榜与头条流中不再显示；不影响采集与推送', 'Disabled sources are hidden from the hotlist & headline stream on this page; crawler & pushes unchanged'],
        ['tt.setSourcesPlatforms', '热榜平台', 'Hotlist Platforms'],
        ['tt.setSourcesFeeds', 'RSS 信源', 'RSS Feeds'],
        ['tt.saveBtn', '保存并重新生成选题', 'Save & rescore'],
        ['tt.cancelBtn', '取消', 'Cancel'],
        ['tt.savedToast', '设置已保存，正在重新生成选题榜…', 'Settings saved. Rescoring started…'],
        ['tt.keywordsQuick', '关键词快速高亮', 'Keyword quick highlight'],
    ]);

    // ═══════════════════════════════════════
    //  选题库
    // ═══════════════════════════════════════
    add([
        ['tt.libTitle', '选题库', 'Topic Library'],
        ['tt.libSubtitle', '个人收藏池 · 独立于 TOP10 评分', 'Your personal pool · independent of TOP10 scoring'],
        ['tt.libUpload', '上传', 'Upload'],
        ['tt.libCount', '{0} 条', '{0} items'],
        ['tt.libEmpty', '选题库为空。点击「上传」批量导入，或在左侧 TOP10 卡片点「入库」。', 'Empty. Click "Upload" to import in bulk, or "Add" on TOP10 cards.'],
        ['tt.libAdd', '入库', 'Add'],
        ['tt.libAdded', '已入库', 'Added'],
        ['tt.libAddToast', '已加入选题库', 'Added to topic library'],
        ['tt.libDupToast', '该选题已在选题库中', 'Already in your topic library'],
        ['tt.libImportTitle', '批量入库', 'Import Topics'],
        ['tt.libImportLabel', '粘贴选题（每行一条）', 'Paste topics (one per line)'],
        ['tt.libImportPlaceholder', '粘贴要入库的选题，每行一条，支持 1. 序号与 - 列表符号…', 'Paste topics to import, one per line; numbered/bulleted lists OK…'],
        ['tt.libImportHint', '自动去除序号/列表符号；重复标题自动跳过', 'Numbering/bullets are stripped; duplicate titles are skipped'],
        ['tt.libImportBtn', '批量入库', 'Import'],
        ['tt.libNeedText', '请先粘贴要入库的选题', 'Paste some topics first'],
        ['tt.libImportToast', '新增 {0} 条 · 跳过 {1} 条', '{0} added · {1} skipped'],
        ['tt.libInvalid', '无效 {0} 条', '{0} invalid'],
        ['tt.libDelete', '删除', 'Delete'],
        ['tt.libDeleteConfirm', '确认从选题库删除这条选题？', 'Remove this topic from the library?'],
        ['tt.libDeleted', '已删除', 'Deleted'],
        ['tt.libStatusNone', '未处理', 'To-do'],
        ['tt.libStatusPending', '待处理', 'Pending'],
        ['tt.libStatusDoing', '处理中', 'Doing'],
        ['tt.libStatusDone', '已完成', 'Done'],
        ['tt.libOriginSystem', '系统', 'System'],
        ['tt.libOriginUser', '手动', 'Manual'],
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
