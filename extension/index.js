const engine = window.SillyTavernLink;
const container = document.createElement('div');
container.className = 'stlink-settings';
container.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header">
<b>SillyTavern Link</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content"><p data-link-status>正在载入…</p><small data-link-detail></small>
<div class="stlink-buttons"><button class="menu_button" data-link-sync>立即保存进度</button>
<button class="menu_button" data-link-resume>在此设备接着玩</button><button class="menu_button" data-link-backups>查看备份</button></div>
<label class="stlink-backup-option"><input type="checkbox" data-link-backup-enabled><span>接续前备份本设备旧数据</span></label>
<p class="stlink-note">关闭后此浏览器不再做接续前备份，双向同步照常进行。备份窗口也可跳过一次。电脑端的冲突保护备份仍保留 24 小时，到期自动清理。</p>
<p class="stlink-note">打开页面时接续最新数据，游玩中自动上传。不会自动刷新。切换设备时，上一设备会先保存进度。</p>
</div></div>`;
(document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings'))?.append(container);
if (!engine || engine.disabled) {
    container.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
    container.querySelector('[data-link-status]').textContent = engine?.disabled
        ? '扩展已安装；请重启酒馆服务，再刷新本页以启用同步。'
        : '扩展文件已下载，还需在电脑完成一次配套安装。';
    container.querySelector('[data-link-detail]').textContent = '关闭酒馆服务，打开酒馆目录下的 public/scripts/extensions/third-party/sillytavern-link，双击 Install.cmd，再重新启动酒馆并刷新本页。通过 GitHub 安装时请勾选“为所有用户安装”。';
} else {
    const update = () => {
        const d = engine.diagnostics();
        container.querySelector('[data-link-backup-enabled]').checked = d.backupEnabled;
        container.querySelector('[data-link-status]').textContent = d.message;
        container.querySelector('[data-link-detail]').textContent = `${d.storageKeys} 项浏览器设置 · ${d.databases.length} 个数据库 · ${d.records} 条记录${d.lastUpload ? ' · 最近上传 ' + new Date(d.lastUpload).toLocaleTimeString() : ''}${d.problem ? '\n' + d.problem : ''}`;
    };
    window.addEventListener('stlink:status', update); update();
    container.querySelector('[data-link-backup-enabled]').onchange = event => engine.setBackupEnabled(event.target.checked);
    container.querySelector('[data-link-sync]').onclick = async () => {
        if (!engine.active) return engine.standby();
        const { saveSettings } = await import('/script.js'); await saveSettings();
        await engine.tick(true); update();
    };
    container.querySelector('[data-link-resume]').onclick = () => {
        if (engine.busy()) return window.toastr?.info('请先完成生成、编辑或发送输入框里的消息，再接续。');
        location.reload();
    };
    container.querySelector('[data-link-backups]').onclick = () => engine.downloadBackups().catch(e => engine.status('无法读取备份', e.message));
    const context = SillyTavern.getContext();
    context.eventSource.on(context.event_types.APP_READY, () => engine.start(SillyTavern.getContext()));
}
