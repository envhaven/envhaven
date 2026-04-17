<script>
(function() {
  const DB_NAME = 'vscode-web-state-db-global';
  const STORE_NAME = 'ItemTable';
  const MARKER_KEY = '__$__envhavenDefaultsApplied';

  const defaultState = {
    "workbench.activity.pinnedViewlets2": JSON.stringify([
      {"id":"workbench.view.extension.envhaven-sidebar","pinned":true,"visible":true,"order":0},
      {"id":"workbench.view.explorer","pinned":true,"visible":true,"order":1},
      {"id":"workbench.view.search","pinned":true,"visible":true,"order":2},
      {"id":"workbench.view.scm","pinned":false,"visible":false,"order":3},
      {"id":"workbench.view.debug","pinned":false,"visible":false,"order":4},
      {"id":"workbench.view.remote","pinned":false,"visible":false,"order":5},
      {"id":"workbench.view.extensions","pinned":false,"visible":false,"order":6},
      {"id":"workbench.view.chat.sessions","pinned":false,"visible":false,"order":7},
      {"id":"workbench.view.extension.test","pinned":false,"visible":false,"order":8},
      {"id":"workbench.view.extension.references-view","pinned":false,"visible":false,"order":9}
    ]),
    "workbench.activity.showAccounts": "false",
    "workbench.explorer.views.state.hidden": JSON.stringify([
      {"id":"outline","isHidden":true},
      {"id":"timeline","isHidden":true},
      {"id":"workbench.explorer.openEditorsView","isHidden":true},
      {"id":"workbench.explorer.fileView","isHidden":false},
      {"id":"npm","isHidden":true}
    ]),
    "workbench.scm.views.state.hidden": JSON.stringify([
      {"id":"workbench.scm.repositories","isHidden":true},
      {"id":"workbench.scm","isHidden":false},
      {"id":"workbench.scm.history","isHidden":false}
    ]),
    "menu.hiddenCommands": JSON.stringify({
      "ViewTitle": [
        "workbench.files.action.createFolderFromExplorer",
        "workbench.files.action.refreshFilesExplorer",
        "workbench.files.action.collapseExplorerFolders",
        "workbench.files.action.createFileFromExplorer",
        "workbench.action.terminal.split"
      ],
      "EditorTitle": [
        "workbench.action.splitEditor"
      ]
    }),
    "workbench.panel.pinnedPanels": JSON.stringify([
      {"id":"workbench.panel.markers","pinned":false,"visible":false,"order":0},
      {"id":"workbench.panel.output","pinned":false,"visible":false,"order":1},
      {"id":"workbench.panel.repl","pinned":false,"visible":false,"order":2},
      {"id":"terminal","pinned":true,"visible":false,"order":3},
      {"id":"workbench.panel.testResults","pinned":true,"visible":false,"order":3},
      {"id":"~remote.forwardedPortsContainer","pinned":true,"visible":false,"order":5},
      {"id":"refactorPreview","pinned":true,"visible":false}
    ]),
    "workbench.auxiliarybar.pinnedPanels": JSON.stringify([
      {"id":"workbench.panel.chat","pinned":true,"visible":false,"order":1},
      {"id":"workbench.viewContainer.agentSessions","pinned":true,"visible":false,"order":6}
    ]),
    "workbench.panel.alignment": "center",
    "welcomeOnboarding.state": "true"
  };

  function applyDefaults() {
    const request = indexedDB.open(DB_NAME);

    request.onupgradeneeded = function(event) {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = function(event) {
      const db = event.target.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const checkRequest = store.get(MARKER_KEY);
      checkRequest.onsuccess = function() {
        if (checkRequest.result) {
          db.close();
          return;
        }

        for (const [key, value] of Object.entries(defaultState)) {
          store.put(value, key);
        }
        store.put('true', MARKER_KEY);

        tx.oncomplete = function() {
          db.close();
        };
      };
    };

    request.onerror = function() {};
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyDefaults);
  } else {
    applyDefaults();
  }
})();
</script>
