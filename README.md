# CodeGraph G6 Viewer

Interactive call-graph visualization for VS Code powered by [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) and [AntV G6](https://g6.antv.antgroup.com/).

- Browse the full call graph of any file with a single right-click
- Trace a selected symbol's callers and callees
- Expand / collapse nodes on the fly with double-click
- Navigate to source definitions from the graph

![CodeGraph G6 Viewer](images/screenshot.png)

## Requirements

This extension requires a **CodeGraph-indexed workspace**. On first launch it detects whether the project has been initialized and prompts you to run indexing if needed.

You can also trigger indexing manually at any time:

- **Command Palette** (`Ctrl+Shift+P`) → `CodeGraph: Initialize / Re-index`

Indexing runs in the background via `npx @colbymchenry/codegraph init`.

## Usage

1. Open any source file in a CodeGraph-indexed workspace.
2. **Right-click** the editor (no selection needed) → `CodeGraph: Show Node Graph`.
   - **No selection**: the graph shows all functions, methods, and classes in the current file and their immediate call relationships.
   - **With text selected**: the graph centers on that symbol — showing its callers (incoming) and callees (outgoing).
3. The graph opens in a side panel.

### Graph interactions

| Action | Result |
|--------|--------|
| **Double-click** a node | Expand one level — query callers and callees of that node |
| **Double-click** an expanded node | Collapse its subtree |
| **Right-click** a node → `Source` | Jump to the symbol's definition in the editor |
| Drag canvas | Pan the view |
| Scroll | Zoom in / out |
| Drag a node | Reposition it |

### Toolbar

| Button | Action |
|--------|--------|
| Undo / Redo | Step through expand / collapse history |
| Reset | Return to the initial graph |
| Zoom In / Zoom Out / Fit | Adjust the viewport |

## Extension Settings

This extension contributes the following settings (`codegraphG6.*`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `codegraphG6.maxDepth` | `number` | `2` | Default expansion depth (1–10) |
| `codegraphG6.direction` | `string` | `both` | Traversal direction: `both`, `upstream`, or `downstream` |

## Commands

| Command | ID | Description |
|---------|-----|-------------|
| `CodeGraph: Show Node Graph` | `codegraph-g6.showGraph` | Open the call graph for the current file or selected symbol |
| `CodeGraph: Initialize / Re-index` | `codegraph-g6.manualInit` | Run CodeGraph indexing on the workspace |

## How It Works

1. **CodeGraph** parses the project into a SQLite knowledge graph of symbols and cross-references.
2. On `Show Node Graph`, the extension queries CodeGraph's database for nodes and edges.
3. The data is rendered as an interactive DAG using **AntV G6** in a VS Code webview panel.
4. Double-clicking a node triggers an incremental backend query; new nodes and edges are added without rebuilding the entire layout.

## Development

```bash
npm install
npm run watch        # watch + rebuild on changes
```

Press `F5` in VS Code to launch an Extension Development Host.

## License

MIT
