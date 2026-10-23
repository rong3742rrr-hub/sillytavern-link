import { LinkEngine } from './engine.mjs';

const style = document.createElement('link');
style.rel = 'stylesheet'; style.href = new URL('./style.css', import.meta.url).href;
document.head.append(style);
const engine = new LinkEngine();
window.SillyTavernLink = engine;
try {
    await engine.initialize();
    // Both original entry points are delayed until browser data is hydrated.
    // i18n imports ST modules too, so delaying only script.js would be insufficient.
    await import('/scripts/i18n.js');
    await import('/script.js');
} catch (error) {
    if (error.code === 'SERVER_MISSING') {
        // Installation may finish while the old server is still running. Preserve normal ST use until its next restart.
        engine.disabled = true; engine.hide();
        engine.status('尚未启用同步：请重启酒馆服务', '当前仍是原来的酒馆，重启后才能建立电脑同步基准。');
        await import('/scripts/i18n.js'); await import('/script.js');
    } else engine.fail(error);
}
