/**
 * Browser manager: a single reusable Playwright Chromium instance shared by
 * every browser_* tool in the plugin, so the agent can drive a page across
 * multiple tool calls without losing state.
 *
 * Shared-mode (default): the browser runs inside the host process with a
 * persistent profile and a CDP debugging port (9222), so a human can attach
 * their own DevTools UI (http://127.0.0.1:9222) for logins etc. If the port is
 * already taken by another instance, the manager connects to it instead —
 * the agent then drives the very same browser and session the human sees.
 */
import { chromium } from 'playwright-core';
import { createScopePolicy, createScopeProxy, verifyGuardedBrowser, targetOriginHash, GUARD_ARGS, scopeError } from './scope.js';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
/** Channels tried in order when neither executablePath nor channel is set. */
const CHANNEL_CANDIDATES = ['chromium', 'chrome', 'msedge'];
/** Persistent profile shared between human UI and agent tools. */
const DEFAULT_SHARED_PROFILE = '/home/silkspool/日常/browser/.shared-browser-profile';
const DEFAULT_CDP_PORT = 9222;

async function cdpAlive(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        return res.ok;
    }
    catch {
        return false;
    }
}

function observePageRequests(context) {
    const origins = new Set();
    const pages = new Set();
    let overflow = false;
    const observe = item => {
        let matches;
        try {
            const raw = item.url();
            matches = [targetOriginHash(raw)];
            // Chromium 也会用 CONNECT 承载明文 ws。代理只能看到 authority，
            // 统一记为 https://authority；保留 ws 的实际端口来关联该拒绝。
            if (raw.startsWith('ws:')) {
                const url = new URL(raw);
                matches.push(targetOriginHash(`https://${url.hostname}:${url.port || '80'}/`));
            }
        } catch { return; }
        for (const origin of matches) {
            if (origins.size >= 4096 && !origins.has(origin)) { overflow = true; return; }
            origins.add(origin);
        }
    };
    const page = value => {
        if (pages.has(value)) return;
        pages.add(value);
        value.on('websocket', observe);
    };
    // BrowserContext 的 request 覆盖页面、弹窗及 Service Worker 发出的 HTTP 请求。
    // WebSocket 由 Page 的独立事件补齐；Chromium 自身更新/登录请求不属于此上下文。
    context.on('request', observe);
    context.on('page', page);
    context.pages().forEach(page);
    return {
        origins,
        get overflow() { return overflow; },
        stop() {
            context.off('request', observe);
            context.off('page', page);
            for (const value of pages) value.off('websocket', observe);
        },
    };
}

export class BrowserManager {
    browser;
    currentPage;
    context;
    config;
    /** 'shared' | 'cdp' | 'plain' — how the browser was acquired. */
    launchMode;

    constructor(config) {
        this.config = config;
        this.tail = Promise.resolve();
    }
    async run(name, args, exec, callback) {
        const previous = this.tail;
        let release;
        this.tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (exec?.signal?.aborted) throw new Error('Browser action cancelled');
            if (name === 'browser_close' || name === 'browser_install') return await callback();
            this.policy ??= await createScopePolicy();
            if (name === 'browser_screenshot') {
                const baseDir = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh';
                const dataDir = process.env.SEC_DATA_DIR || path.join(baseDir, 'data');
                const { workspaceWriteRefusal } = await import(pathToFileURL(path.join(baseDir, 'plugins/sec-suite/native-guard.js')).href);
                const filename = args.path || path.join(this.config.screenshotDir || 'browser-screenshots', `shot-${Date.now()}.png`);
                const refusal = workspaceWriteRefusal({ cwd: exec?.agent?.session?.header?.cwd, filename, baseDir, dataDir });
                if (refusal) throw new Error(refusal);
                args.path = filename;
            }
            if (name === 'browser_open' || name === 'browser_navigate') {
                if (args.url && args.url !== 'about:blank') this.policy.check(args.url);
            }
            await this.launch();
            if (name !== 'browser_open' && name !== 'browser_navigate' && this.currentPage.url() !== 'about:blank') {
                this.policy.check(this.currentPage.url());
            }
            const guardStatus = async () => this.scopeProxy?.status()
                ?? await verifyGuardedBrowser(this.browser, this.policy);
            const before = await guardStatus();
            const observed = observePageRequests(this.currentPage.context());
            try {
                let result, actionError;
                try { result = await callback(); } catch (error) { actionError = error; }
                const after = await guardStatus();
                if (observed.overflow || after.denied < before.denied || after.denied - before.denied > after.denials.length) {
                    throw scopeError('页面请求的拒绝审计超出保留窗口，无法核实本次操作');
                }
                if (after.denials.some(row => row.sequence > before.denied && observed.origins.has(row.origin))) {
                    throw scopeError('页面请求被 Scope 出口守卫拒绝');
                }
                if (this.currentPage?.url() && this.currentPage.url() !== 'about:blank') this.policy.check(this.currentPage.url());
                if (actionError) throw actionError;
                return result;
            } finally { observed.stop(); }
        } finally { release(); }
    }
    async attach(url, viewport) {
        const endpoint = new URL(url);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
            throw scopeError('CDP 必须连接同机受管浏览器');
        }
        this.browser = await chromium.connectOverCDP(url);
        try { await verifyGuardedBrowser(this.browser, this.policy); }
        catch (error) {
            // connectOverCDP 的 close 只断开此客户端的 transport，不关闭宿主。
            await this.browser.close().catch(() => {});
            this.browser = undefined;
            throw error;
        }
        this.launchMode = 'cdp';
        const contexts = this.browser.contexts();
        if (!contexts.length) throw scopeError('共享浏览器缺少可核实的持久上下文');
        this.context = contexts[0];
        this.currentPage = this.context.pages()[0] ?? await this.context.newPage();
        await this.currentPage.setViewportSize(viewport);
    }
    get isOpen() {
        if (this.browser === undefined)
            return false;
        return this.browser.isConnected();
    }
    async launch() {
        if (this.isOpen)
            return;
        this.policy ??= await createScopePolicy();
        const { executablePath, channel, viewport, cdpUrl, cdpPort, userDataDir, headless } = this.config;
        const vp = viewport ?? { width: 1280, height: 800 };
        const guardedProxy = async () => {
            this.scopeProxy ??= await createScopeProxy({ policy: this.policy });
            return { server: this.scopeProxy.server, bypass: this.scopeProxy.bypass };
        };

        // 1) Explicit CDP connection to an externally managed browser.
        if (cdpUrl) {
            await this.attach(cdpUrl, vp);
            return;
        }

        // 2) Shared mode (default): persistent profile + CDP port inside the host,
        //    or attach to an already-running shared browser on that port.
        const wantShared = process.env.SEC_SHARED_BROWSER !== '0' && !executablePath && !channel;
        if (wantShared) {
            const port = cdpPort ?? DEFAULT_CDP_PORT;
            const profile = userDataDir ?? DEFAULT_SHARED_PROFILE;
            try {
                if (await cdpAlive(port)) {
                    await this.attach(`http://127.0.0.1:${port}`, vp);
                    return;
                }
                const ctx = await chromium.launchPersistentContext(profile, {
                    headless: headless !== false,
                    proxy: await guardedProxy(),
                    args: [
                        ...GUARD_ARGS,
                        '--no-sandbox',
                        '--disable-dev-shm-usage',
                        `--remote-debugging-port=${port}`,
                        '--remote-allow-origins=*',
                        '--disable-gpu',
                        '--no-first-run',
                        '--no-default-browser-check',
                    ],
                });
                this.context = ctx;
                this.browser = ctx.browser();
                this.launchMode = 'shared';
                this.currentPage = ctx.pages()[0] ?? (await ctx.newPage());
                return;
            }
            catch (err) {
                if (executablePath || channel) {
                    // explicit config: fall through to plain mode once
                }
                else {
                    const detail = err instanceof Error ? err.message : String(err);
                    throw new Error(`Shared browser launch failed: ${detail}`);
                }
            }
        }

        // 3) Plain mode: ephemeral headless browser (original behaviour).
        const attempts = [];
        if (executablePath) {
            attempts.push({ executablePath });
        }
        else if (channel) {
            attempts.push({ channel });
        }
        else {
            attempts.push(...CHANNEL_CANDIDATES.map((c) => ({ channel: c })));
        }
        let lastError;
        for (const opts of attempts) {
            try {
                this.browser = await chromium.launch({
                    proxy: await guardedProxy(),
                    headless: headless !== false,
                    ...opts,
                    args: [...GUARD_ARGS, '--no-sandbox', '--disable-dev-shm-usage'],
                });
                this.launchMode = 'plain';
                this.currentPage = await this.browser.newPage({ viewport: vp });
                if (this.config.navigationTimeoutMs) {
                    this.currentPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
                    this.currentPage.setDefaultTimeout(this.config.navigationTimeoutMs);
                }
                return;
            }
            catch (err) {
                lastError = err;
            }
        }
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Browser launch failed: ${detail}. ` +
            'Install a browser with: npx playwright install chromium — ' +
            'or configure launch.executablePath / launch.channel in the plugin config.');
    }
    /** Return the current page, launching the browser on first use. */
    async page() {
        if (!this.currentPage || !this.isOpen) {
            await this.launch();
        }
        return this.currentPage;
    }
    async close() {
        try {
            if (this.launchMode === 'cdp') {
                // Playwright 的 CDP close 仅断开连接；不能遗留已失效的引用。
                await this.browser?.close();
            }
            else if (this.launchMode === 'shared') {
                await this.context?.close();
            }
            else {
                await this.browser?.close();
            }
        }
        catch {
            // Browser already gone; nothing to do.
        }
        await this.scopeProxy?.close();
        this.scopeProxy = undefined;
        this.browser = undefined;
        this.context = undefined;
        this.currentPage = undefined;
    }
}
/** Best-effort JSON-safe serialization of a page-eval result. */
export function toJsonSafe(value) {
    if (value === undefined)
        return null;
    if (typeof value !== 'object' || value === null)
        return value;
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return String(value);
    }
}
