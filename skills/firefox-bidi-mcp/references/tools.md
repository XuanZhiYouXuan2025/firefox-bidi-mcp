# 187 个 browser_* 工具速查

> 按域分组。下表名字省略 `browser_` 前缀，实际调用要带。
> ⚠️ 本文件由 `scripts/gen-tools-doc.mjs` 从 `src/tools/*.ts` 生成 —— 改工具请改源码后重跑，⛔ 别手改这里。

## 页面操作（18）

- `evaluate` — Run an expression in the page and return its value (JSON)
- `click` — Click the first element matching a CSS selector with a real mouse action (pointer move…
- `type` — Focus the element matching a CSS selector and type text with real per-character key events
- `navigate` — Navigate the active tab to a URL and wait for the page to load
- `screenshot` — Capture a base64 PNG
- `pdf` — Render the page to PDF and return it base64-encoded (verified: browsingContext.print returns…
- `pick_color_at` — Capture the viewport and return the colour at a CSS-pixel coordinate (x from the left, y…
- `hover` — Move the real mouse pointer onto an element (or a viewport coordinate) so hover-only UI…
- `scroll` — Scroll the page (or one scrollable element) using real wheel events (BiDi…
- `press_key` — Send a real key press, optionally with modifiers — Ctrl/Shift/Alt/Meta plus one key
- `page_source` — Return the serialised DOM of a tab (document.documentElement.outerHTML)
- `get_page_text` — Return document.body.innerText (what a human would read, not HTML)
- `wait_for` — Poll until a CSS selector matches (state "attached") or matches AND is visible (state…
- `fill_form` — Set values for multiple fields in ONE round trip and fire input/change events so ordinary…
- `screencast` — Start / capture / stop a BiDi screencast (browsingContext.startScreencast)
- `take_snapshot` — Walk the DOM and return a text outline in which every interactive element carries a UID…
- `click_by_uid` — Click the element that browser_take_snapshot labelled with this UID, using the same real…
- `fill_by_uid` — Focus the field that browser_take_snapshot labelled with this UID and type into it with real…

## 标签页（5）

- `page_info` — Read the active tab title and URL
- `list_tabs` — List open tabs with their context id, URL and title
- `new_tab` — Open a new tab, optionally navigating it to a URL
- `close_tab` — Close one tab (browsingContext.close)
- `activate_tab` — Make a tab the active one (browsingContext.activate)

## 标签页进阶（22）

- `list_closed_tabs` — List tabs that were closed in this session (SessionStore.getClosedTabData), newest first…
- `reopen_closed_tab` — Reopen a tab that was closed in this session (SessionStore.undoCloseTab)
- `split_view` — Put two tabs side by side in one window (Firefox split view, gBrowser.addTabSplitView)
- `unsplit_view` — Close the split view in the current window (gBrowser.unsplitView on the active tab)
- `group_tabs` — Create a tab group from the given tabs (Firefox tab groups, gBrowser.addTabGroup)
- `duplicate_tab` — Duplicate a tab, keeping its history and state (Firefox tab cloning, gBrowser.duplicateTab)
- `pin_tab` — Pin a tab (it shrinks to an icon and stops being closed by "close others") or unpin it again
- `mute_tab` — Mute a tab so it stays silent in the background, or unmute it
- `close_other_tabs` — Close all tabs in the window except the given one ("close other tabs" in the tab context menu)
- `close_tabs_to_right` — Close every tab to the right of the given one ("close tabs to the right" in the tab context…
- `move_tab_to_window` — Take a tab out of its window and put it in a new window (gBrowser.replaceTabWithWindow)
- `move_tab_to_container` — Reopen the current page in a tab belonging to a container/user context, then close the…
- `move_tab` — Move a tab to a new position in the tab strip
- `remove_duplicate_tabs` — Close tabs that load the same page as another tab, keeping one of each…
- `close_tabs_by_url` — Close all tabs whose URL contains the given text
- `list_tab_groups` — List the tab groups (collapsible groups in the tab strip) with their id, label, colour…
- `remove_tab_group` — Remove a tab group by id (gBrowser.removeTabGroup)
- `get_tab_processes` — Report the OS process id behind each tab (browsingContext.currentWindowGlobal.osPid)
- `move_tab_to_group` — Move a tab into a group that already exists (gBrowser.moveTabToExistingGroup)
- `move_tab_to_split_view` — Move a tab into the split view that is already open in this window (gBrowser.moveTabToSplitView)
- `multi_select_tabs` — Multi-select tabs so batch operations apply to all of them (gBrowser.addToMultiSelectedTabs…
- `set_tab_visible` — Hide a tab from the tab strip (gBrowser.hideTab) or bring it back (gBrowser.showTab)

## 窗口与视口（10）

- `set_viewport` — Set (or clear) the BiDi viewport override and read back the result
- `set_window_size` — Set the client window position and size through BiDi (browser.setClientWindowState)
- `new_window` — Open a new browser window (BiDi browsingContext.create with type "window") and return its…
- `close_window` — Close a whole window — every tab in it (BiDi browsingContext.close on a top-level context)
- `set_window_state` — Change the window state: normal, maximized, minimized or fullscreen
- `set_window_position` — Move the window to a screen coordinate (window.moveTo) and optionally resize it…
- `get_window_geometry` — Report the window state (normal/maximized/minimized/fullscreen), its screen position and its…
- `picture_in_picture` — Open a floating always-on-top mini window showing a URL (Document Picture-in-Picture)
- `screen_info` — Report the screen the window is on: size, usable area, and the window position within it
- `list_windows` — List Firefox windows with their state and geometry (privileged context)

## 工具栏与侧栏（9）

- `get_toolbar_layout` — List which widgets sit in each toolbar area (nav-bar, TabsToolbar, PersonalToolbar, ...)…
- `set_toolbar_widget` — Move a widget into a toolbar area, or remove it from wherever it is…
- `set_toolbar_visibility` — Show or hide a whole toolbar such as the bookmarks toolbar or the menu bar…
- `list_sidebars` — List every sidebar this Firefox can show (history, bookmarks, passwords, tabs, AI chat…
- `set_sidebar` — Open a sidebar by id, close the current one, or toggle it
- `set_menubar_visibility` — Show or hide the classic menu bar (File/Edit/View…)
- `set_downloads_panel` — Open or close the downloads panel (the toolbar arrow that lists recent downloads)
- `set_main_menu` — Open or close the application (hamburger) menu, the same one the ☰ button opens
- `toolbar_widgets` — List the widget ids currently in a toolbar area (privileged context)

## 书签（8）

- `add_bookmark` — Insert a bookmark (PlacesUtils.bookmarks.insert) and return its guid, which is what…
- `remove_bookmark` — Remove a bookmark or folder by guid (PlacesUtils.bookmarks.remove)
- `bookmark_folder` — Manage bookmark FOLDERS (the existing bookmark tools only handle individual bookmarks)
- `bookmark_manage` — The management half of bookmarks that browser_add_bookmark / remove_bookmark /…
- `bookmark_backup` — List the JSON bookmark backups in the profile and optionally create a new one
- `bookmarks_export` — Write the bookmark tree to a Netscape Bookmark HTML file
- `bookmarks_import` — Read a Netscape Bookmark HTML file and recreate its folders and links under a chosen…
- `list_bookmarks` — Read bookmarks from a folder (privileged context), each entry with the guid that…

## 历史（2）

- `history_manage` — The management half of history that browser_list_history does not cover
- `list_history` — Read recent history entries (privileged context)

## 网络与下载（12）

- `set_download_dir` — Point Firefox at a download directory (privileged context) by writing…
- `network_requests` — Report network activity seen since this server connected: network.beforeRequestSent (request…
- `network_intercept` — Turn BiDi request interception on or off (network.addIntercept / removeIntercept, phase…
- `network_continue_all` — Continue every request currently held by interception (network.continueRequest for each)
- `network_provide_response` — Fulfil one intercepted request with your own response body (network.provideResponse)…
- `list_download_events` — Report the download events the browser pushed since this server connected…
- `list_downloads` — List the files sitting in the configured download directory of Firefox (read via the…
- `collect_response_body` — Turn on BiDi response-body collection (network.addDataCollector)
- `get_response_body` — Read the stored body of one request (network.getData, dataType response)
- `set_download_state` — Act on one entry of the download list by index (as shown by browser_list_downloads): pause…
- `download_manage` — The management half of downloads that browser_list_downloads and set_download_state do not cover
- `download_add` — Begin a download of a URL to a local file

## Cookie / 缓存 / 站点数据（12）

- `get_cookies` — List cookies visible to the browser (BiDi storage.getCookies)
- `set_cookie` — Create or replace one cookie (BiDi storage.setCookie)
- `delete_cookies` — Delete cookies matching a filter (BiDi storage.deleteCookies)
- `set_permission` — Set one permission for an origin (BiDi permissions.setPermission)
- `create_container` — Create a new container / user context (BiDi browser.createUserContext) and return its id
- `remove_container` — Delete a container / user context by id (BiDi browser.removeUserContext)
- `clear_data` — Delete stored data for ONE host or origin (ClearDataService)
- `get_cache_usage` — Report the size of the on-disk HTTP cache (Services.cache2.asyncGetDiskConsumption)
- `clear_cache` — Clear the on-disk HTTP cache (Services.cache2.clear)
- `list_permissions` — List the per-site permission grants Firefox has stored (camera, microphone, notifications…
- `clear_site_cache` — Clear cached data for a SINGLE site instead of the whole cache
- `list_user_contexts` — List BiDi user contexts

## 密码与自动填充（13）

- `list_logins` — List saved logins from the Firefox password manager, with origin, form action origin and…
- `add_login` — Save a username/password pair in the Firefox password manager
- `remove_login` — Delete saved logins
- `get_login_password` — SECURITY SENSITIVE — returns a saved password in clear text
- `find_login_form` — Inspect the page for login/registration forms: each form id and action, plus its input…
- `fill_login` — Type a username and password into a form using real keystroke input (not a scripted value…
- `autofill_status` — Report the address / credit-card autofill state
- `autofill_data` — Read and write the saved form-autofill ADDRESSES (not passwords)
- `import_logins` — Import saved logins from a CSV (the format Chrome and Firefox both export)
- `import_cookies` — Set a batch of cookies in one call instead of one browser_set_cookie per cookie
- `import_cookies_from_file` — Read a JSON file containing an array of cookie objects and set them all inside the existing…
- `import_logins_from_file` — Read a JSON file holding an array of {origin, user, password} and insert each one through…
- `import_history` — Read a JSON file holding an array of {url, title, lastVisit, visitCount} and insert each…

## 设置（9）

- `get_proxy` — Read the proxy settings (network.proxy.* preferences): the mode, the manual HTTP/HTTPS/SOCKS…
- `set_proxy` — Set the proxy configuration (network.proxy.* preferences) and read back what was written
- `search_prefs` — Search all Firefox preference NAMES (Services.prefs.getChildList) for a substring and report…
- `reset_pref` — Remove the user value of a preference so it falls back to the built-in default…
- `set_homepage` — Set the homepage (browser.startup.homepage, one URL per line for several) and what Firefox…
- `set_tracking_protection` — Switch the tracking-protection level: off, standard (blocks known trackers in private…
- `set_doh` — Set network.trr.mode (0 off, 2 on with fallback, 3 on only, 5 explicitly off) and optionally…
- `get_pref` — Read a preference by name (privileged context)
- `set_pref` — Set a preference (privileged context)

## 扩展与主题（6）

- `set_addon_state` — Turn an installed extension on or off by id (AddonManager, privileged context)
- `uninstall_addon` — Uninstall an installed extension by id (AddonManager, privileged context)
- `list_themes` — List installed themes and which one is active (AddonManager, type "theme")
- `install_addon` — Install an extension from a local .xpi file or an unpacked extension directory…
- `set_theme` — Activate one of the installed themes by id (from browser_list_themes), or pass default:true…
- `list_addons` — List installed extensions (privileged context)

## 扩展与篡改猴（11）

- `extension_details` — Report what UI entry points an extension actually exposes: its options page URL, browser…
- `open_extension_options` — Open the options page of an extension in a new tab, resolved from its live manifest…
- `open_extension_popup` — Open the browser-action popup of an extension, the same thing clicking its toolbar button does
- `close_extension_popup` — Close the tool-panel popup that browser_open_extension_popup opened, by hiding the widget panel
- `extension_storage` — Read or write the private key/value storage of an extension (browser.storage.local) — where…
- `run_in_extension` — Evaluate an expression inside the context of one of the extension own pages, where the…
- `tampermonkey_list` — List the userscripts Tampermonkey currently manages, by asking its own internal API (loadTree)
- `tampermonkey_install` — Install (or update) a userscript by handing its source to Tampermonkey saveScript
- `tampermonkey_set_enabled` — Turn a userscript on or off in Tampermonkey (modifyScriptOptions with {enabled})
- `tampermonkey_remove` — Delete userscripts by uuid or by the @name shown in browser_tampermonkey_list (purgeScripts)
- `extension_permissions` — Report the user-granted permissions and origin patterns of installed extensions

## 档案与诊断（7）

- `info` — Report the connected Firefox: version, window count and whether the privileged (chrome)…
- `site_note` — Append one dated line to sites/<domain>.md in this repository — the place to keep hard-won…
- `profile_info` — Report the profile the connected Firefox is running with: profile directory (ProfD), its…
- `quit` — Ask the connected Firefox to exit (browser.close)
- `memory_usage` — Read live memory figures from nsIMemoryReporterManager
- `troubleshoot` — Return the same diagnostic snapshot that about:support shows
- `selfcheck` — Run after a Firefox upgrade: report the version and verify the non-standard pieces this…

## 开发者工具（12）

- `devtools_tools` — List the Developer Tools panels this Firefox exposes (inspector, webconsole, jsdebugger…
- `devtools_open` — Open the Firefox DevTools toolbox on a tab and select one tool panel
- `devtools_close` — Close the DevTools toolbox for a tab, or all of them
- `open_about_page` — Open a Firefox internal page in a new tab
- `about_page_info` — Report the title and visible text of an already-open about: page, so a caller can confirm…
- `console` — Open or close the Browser Console (the Ctrl+Shift+J window that logs browser-wide messages)
- `responsive_mode` — Open, close or query Firefox Responsive Design Mode for a tab
- `eyedropper` — Drive the DevTools eyedropper / colour picker on a tab
- `remote_debugging` — Report or change Firefox remote debugging settings — the "Remote Debugging" entry in the…
- `element_screen_coords` — Return the on-screen pixel centre of an element, for handing to a native input driver (Cua…
- `dom_tree` — Walk a real DOM tree through the DevTools inspector walker and return a bounded outline
- `a11y_tree` — Walk the accessibility tree through the DevTools accessibility front and return a bounded…

## 自动化标记与 GPC（3）

- `get_gpc` — Read whether the browser sends the Global Privacy Control signal (Sec-GPC header)
- `set_gpc` — Enable or disable the Global Privacy Control signal (requests then carry Sec-GPC: 1)
- `hide_automation_flags` — Make pages stop seeing the automation marker: registers a BiDi preload script that reports…

## 证书（3）

- `list_cert_overrides` — List the TLS certificate exceptions the user has accepted…
- `relax_certificate_checks` — SECURITY SENSITIVE
- `certificate_manage` — Read the certificate database and manage per-host certificate exceptions

## 弹窗与导航历史（3）

- `traverse_history` — Move the active tab through its session history (browsingContext.traverseHistory): delta -1…
- `list_prompts` — List page prompts (alert / confirm / prompt / beforeunload) that opened since this server…
- `handle_prompt` — Answer the alert / confirm / prompt that a page is waiting on (BiDi…

## 输入扩展（拖拽/长按/上传）（5）

- `upload_file` — Attach one or more local files to the file input matching a CSS selector (privileged not…
- `drag` — Perform a real mouse drag: press on the source, move in steps, release on the target
- `key_hold` — Press and HOLD a key for N milliseconds, then release — what you need for games (walk right…
- `mouse_action` — Perform a mouse action other than a plain left click: right button (context menu), middle…
- `drag_html5` — Perform an HTML5 drag-and-drop by dispatching the DOM events…

## 同步与杂项（16）

- `console_logs` — Report console messages the page produced since this server connected (BiDi log.entryAdded)
- `save_session` — Write the current window and tab session to a JSON file (SessionStore.getBrowserState)
- `restore_session` — Replace the current session with one saved earlier (SessionStore.setBrowserState)
- `get_favicon` — Ask Places which favicon URL it has stored for a page (PlacesUtils.favicons.getFaviconForPage)
- `list_popup_notifications` — List the browser doorhanger notifications currently offered (the "Save password?" /…
- `accept_popup_notification` — Press the main action of a doorhanger notification by id — for example accepting "Save…
- `get_search_engine` — Report the default search engine name as configured (browser.search.defaultenginename) plus…
- `search_engine` — Manage Firefox search engines
- `sync_probe` — Inspect the Sync/FxAccounts surface WITHOUT signing in to any real account
- `reader_mode` — Open a tab in Reader View (about:reader) or report whether the current page is reader-able
- `sync_now` — Run the real Firefox Sync engine instead of the mock account
- `open_firefox_view` — Open the Firefox View page (about:firefoxview), the tab that lists recently closed tabs…
- `add_search_engine` — Install a user-defined search engine
- `print` — Open the printing surface for a tab
- `oauth_clients` — List devices and web sessions attached to the signed-in Mozilla account…
- `translations` — Report the full-page translation state and optionally enable the feature

## 性能分析（1）

- `profiler` — Record a performance profile with Services.profiler (chrome context)

---

**合计 187 个 · 分 21 组**
