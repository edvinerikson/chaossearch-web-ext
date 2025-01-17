import browser, {
  Menus, Permissions, Tabs, 
} from 'webextension-polyfill';

import {
  Emoji, kibanaPlus, TabStatus, 
} from './constants';
import {
  getAllPermissions,
  hasPermission,
  removePermissions,
  requestPermissions,
} from './helpers/permissions';
import {
  setIconForActiveTab,
  setIconForTab,
  setIconForTabs,
} from './helpers/browserAction';

const grantedTabs = new Set<number>();

// This is loaded from the assets-manifest.json file in the extension directory.
const contentScriptAssets: Record<'css' | 'js', string[]> = {
  css: [],
  js: [],
};

async function contentScriptHasLoaded(tabId: number): Promise<boolean> {
  const [ hasLoaded ] = await browser.tabs.executeScript(tabId, {
    code: '!! window?.KibanaPlus?.loaded;',
  });

  console.log(`Tab ${tabId} has existing content script: ${hasLoaded}`);

  return hasLoaded;
}

async function useContentScript(tabId: number): Promise<void> {
  console.log(`Loading ${kibanaPlus} content script in tab ${tabId}`);

  const hasLoaded = await contentScriptHasLoaded(tabId);

  if (! hasLoaded) {
    const results = await Promise.allSettled([
      ...contentScriptAssets.css.map(file =>
        browser.tabs.insertCSS(tabId, { file }),
      ),
      ...contentScriptAssets.js.map(file =>
        browser.tabs.executeScript(tabId, { file }),
      ),
    ]);

    console.groupCollapsed('browser tabs asset loading');
    console.table(results);
    console.groupEnd();
  }
}

async function maybeUseContentScript(tab: Tabs.Tab): Promise<void> {
  if (tab.id && grantedTabs.has(tab.id)) {
    await useContentScript(tab.id);
  }
}

async function trackGrantedTabs(tab: Tabs.Tab): Promise<Set<number>> {
  if (tab.id && tab.url) {
    const granted = await hasPermission(tab.url);

    console.log(`${tab.url} granted: ${granted}`);

    granted ? grantedTabs.add(tab.id) : grantedTabs.delete(tab.id);
  }

  return grantedTabs;
}

async function onTabUpdated(
  tabId: number,
  changeInfo: Tabs.OnUpdatedChangeInfoType,
  tab: Tabs.Tab,
): Promise<void> {
  if (
    'status' in changeInfo &&
    changeInfo.status === TabStatus.Complete &&
    tab.url
  ) {
    console.log(`Loaded ${tab.url} into tab ${tabId}`);

    await trackGrantedTabs(tab);

    await setIconForTab(tab);

    await maybeUseContentScript(tab);
  }
}

function onTabRemoved(tabId: number): void {
  grantedTabs.delete(tabId);
}

/**
 * This is called when a tab is focused.
 *
 * @param activeInfo
 */
async function onTabActivated(
  activeInfo: Tabs.OnActivatedActiveInfoType,
): Promise<void> {
  const tab = await browser.tabs.get(activeInfo.tabId);

  await setIconForTab(tab);
}

/**
 * Add or remove permissions.
 * Don't do anything async before asking for permissions. It will fail if you do.
 *
 * @param tab
 */
async function onBrowserActionClicked(
  tab: Tabs.Tab, /* , eventData?: BrowserAction.OnClickData */
): Promise<void> {
  if (tab.id && tab.url) {
    if (grantedTabs.has(tab.id)) {
      await removePermissions(tab.url);
    } else {
      await requestPermissions(tab.url);
    }
  }
}

async function rememberTabsByUrl(url: string[]): Promise<Tabs.Tab[]> {
  const tabs = await browser.tabs.query({ url });

  tabs.forEach(async tab => tab.id && grantedTabs.add(tab.id));

  return tabs;
}

async function forgetTabsByUrl(url: string[]): Promise<Tabs.Tab[]> {
  const tabs = await browser.tabs.query({ url });

  tabs.forEach(async tab => tab.id && grantedTabs.delete(tab.id));

  return tabs;
}

async function onPermissionsAdded(
  permissions: Permissions.Permissions,
): Promise<void> {
  if (! permissions.origins) {
    throw new Error('permissions.origins not set');
  }

  const tabs = await rememberTabsByUrl(permissions.origins);

  tabs.forEach(tab => maybeUseContentScript(tab));
}

async function onPermissionsRemoved(
  permissions: Permissions.Permissions,
): Promise<void> {
  if (! permissions.origins) {
    throw new Error('permissions.origins not set');
  }

  await forgetTabsByUrl(permissions.origins);
}

/**
 * Update the browserAction icon for each Tab that has a permission change.
 */
async function onPermissionsChanged(
  permissions: Permissions.Permissions,
): Promise<void> {
  if (! permissions.origins) {
    throw new Error('permissions.origins not set');
  }

  const tabs = await browser.tabs.query({
    url: permissions.origins,
  });

  await setIconForTabs(tabs);
}

async function fetchJson(path: string): Promise<any> {
  const response = await fetch(browser.runtime.getURL(path), {
    method: 'GET',
    mode: 'same-origin',
    headers: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      Accept: 'application/json',
    },
  });

  const data = await response.json();

  return data;
}

async function init(): Promise<void> {
  const assetsManifest = await fetchJson('assets-manifest.json');

  const { css, js } = assetsManifest.entrypoints?.contentScript.assets ?? {};

  if (css?.length) {
    contentScriptAssets.css = css;
  }

  if (js?.length) {
    contentScriptAssets.js = js;
  }

  const permissions = await getAllPermissions();

  console.group('Current permissions');
  console.dir(permissions);
  console.groupEnd();

  const tabs = await rememberTabsByUrl(permissions.origins as string[]);

  await setIconForTabs(tabs);

  console.info(`${kibanaPlus} background script initialized ${Emoji.ThumbsUp}`);
}

async function onStartup(): Promise<void> {
  await setIconForActiveTab();
}

async function onInstalled(/* details: Runtime.OnInstalledDetailsType */): Promise<void> {
  await setIconForActiveTab();
}

browser.contextMenus.create({
  id: 'copy-json',
  title: 'Copy JSON',
  contexts: [ 'page' ],
});

browser.contextMenus.onClicked.addListener(
  async (info: Menus.OnClickData, tab?: Tabs.Tab): Promise<void> => {
    console.log(info);

    if (tab && info.menuItemId == 'copy-json') {
      const [ copied ] = await browser.tabs.executeScript(tab.id, {
        frameId: info.frameId,
        code: `window?.KibanaPlus?.copyElementText( browser.menus.getTargetElement(${info.targetElementId}) );`,
      });

      console.groupCollapsed(`Menu item clicked: ${info.menuItemId}`);
      console.log(copied);
      console.groupEnd();
    }
  },
);

browser.browserAction.onClicked.addListener(onBrowserActionClicked);

// Filtering doesn't work in Chrome: { properties: [ 'status' ] }
browser.tabs.onUpdated.addListener(onTabUpdated);

browser.tabs.onRemoved.addListener(onTabRemoved);

browser.tabs.onActivated.addListener(onTabActivated);

browser.permissions.onAdded.addListener(onPermissionsAdded);
browser.permissions.onAdded.addListener(onPermissionsChanged);

browser.permissions.onRemoved.addListener(onPermissionsRemoved);
browser.permissions.onRemoved.addListener(onPermissionsChanged);

browser.runtime.onStartup.addListener(onStartup);
browser.runtime.onInstalled.addListener(onInstalled);
browser.runtime
  .setUninstallURL(
    'https://webdeveric.github.io/kibana-plus-web-ext/uninstalled.html',
  )
  .catch(error => console.error(error));

init().catch(error => console.error(error));
