# Novel Chart Builder

[English](./README.md) | [日本語](./README.ja.md)

A lightweight, interactive flowchart editor designed for planning visual novels and branching narrative games. Built with **Bun**, **TypeScript**, **React 19**, and **SQLite (`bun:sqlite`)**.

---

## Features

- **Top-to-Bottom Narrative Flow**
  - Build story charts intuitively from top to bottom by connecting **Rectangles (Story Sections)** and **Diamonds (Branches)** via circular `+` buttons beneath each node.
- **Horizontal Chapter Lanes**
  - Organize your story into visual chapter bands separated by horizontal divider lines.
  - Edit chapter titles inline, add or remove chapters, and drag the bottom border of any chapter lane to resize its height.
- **Right-Side Inspector Drawer**
  - **Rectangles (Sections)**: Edit the section title, full scenario/body text, **END Flag** (hides `+` buttons below terminal sections), and optional multi-branch count.
  - **Diamonds (Branches)**: Edit the branch title, condition/choice notes, and **Branch Count** (displays the exact number of circular `+` buttons beneath the diamond).
- **Unconnected Branch Highlighting**
  - Diamonds automatically turn **red** when one or more of their branch slots do not have a destination connected yet, making it easy to spot incomplete routes at a glance.
- **Edge Condition Comments**
  - Attach condition labels (e.g., `"When SAN <= 80"`, `"Has Silver Key"`) directly onto connecting lines by clicking any line on the canvas or editing within the right-side drawer.
- **Branch Merging**
  - Connect any `+` slot to an existing node on the canvas to merge branching routes back together.
- **Smart Hierarchical Auto-Sort**
  - One-click **Auto-Sort (`⇄`)** arranges nodes into hierarchical layers while inserting virtual pass-through lanes and obstacle-avoiding curves so skip-level connections never hide behind intermediate shapes.
- **Multi-Selection & Group Dragging**
  - Drag on empty canvas space to marquee-select multiple shapes at once.
  - Use `Ctrl + Click` (`Cmd + Click` on macOS) to toggle individual shapes in or out of the selection.
  - Drag any selected shape to move the entire selected group while preserving their relative positions, or press `Delete` / `Backspace` to bulk-delete them.
- **Undo / Redo (`Ctrl + Z` / `Ctrl + Y`)**
  - Full snapshot history for deletions, bulk deletions, node moves, auto-sort, and structural edits, complete with a one-click Undo toast notification after deletions.
- **Canvas Zoom**
  - Zoom between `30%` and `200%` using `Ctrl + Scroll Wheel` or the floating `－` / `100%` / `＋` controls at the bottom right.
- **Dual Persistence & JSON Portability**
  - Changes are automatically saved to both a local SQLite database (`data/flowchart.sqlite` via `bun:sqlite`) and browser `localStorage`.
  - Export and import flowcharts as `.json` files anytime.

---

## Tech Stack

- **Runtime & Bundler**: [Bun](https://bun.sh/) (`Bun.serve` full-stack server + HTML/TSX bundler)
- **Database**: `bun:sqlite` (WAL mode, zero external database dependencies)
- **Frontend**: React 19 + TypeScript 7

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.2 or later

### Installation

```bash
bun install
```

### Start Development Server

```bash
bun run dev
```

Open `http://localhost:3000` in your browser.

### Typecheck & Tests

```bash
# Run TypeScript type checking
bun run typecheck

# Run SQLite & layout test suite
bun test
```

---

## Deploying to Cloudflare (Workers + D1)

This project includes a zero-dependency Cloudflare Worker ([`src/worker.ts`](./src/worker.ts)) and D1 schema ([`schema.sql`](./schema.sql)) that can be deployed alongside any existing Workers on your Cloudflare account without conflict.

1. **Log in to Cloudflare and create a dedicated D1 database** (once per account):
   ```bash
   bun x wrangler login
   bun x wrangler d1 create novel-chart-builder-db
   ```
2. **Copy the returned `database_id`** into [`wrangler.jsonc`](./wrangler.jsonc).
3. **Initialize the D1 tables** (optional — [`src/worker.ts`](./src/worker.ts) also auto-initializes tables on first request):
   ```bash
   bun x wrangler d1 execute novel-chart-builder-db --remote --file=./schema.sql
   ```
4. **Configure Google Authentication & Access Control**:
   - **Option A — Cloudflare Zero Trust (Access) (Recommended)**:
     1. In the Cloudflare dashboard, navigate to **Zero Trust > Access > Applications** and add a **Self-hosted** application for your Worker's domain (`novel-chart-builder.<your-subdomain>.workers.dev`).
     2. Configure **Google** as the Identity Provider and create an Allow policy for your Google email address.
     3. *(Optional defense-in-depth, without exposing your email in Git)* Store your allowed email as an encrypted Cloudflare Secret:
        ```bash
        bun x wrangler secret put ALLOWED_EMAILS
        ```
   - **Option B — Built-in Google Sign-In (`GOOGLE_CLIENT_ID`)**:
     1. Store `ALLOWED_EMAILS` and `GOOGLE_CLIENT_ID` via `bun x wrangler secret put ALLOWED_EMAILS` (or in the Cloudflare Dashboard under **Workers & Pages > Settings > Variables and Secrets**) so no personal addresses are committed to the repository.
5. **Build and deploy**:
   ```bash
   bun run cf:deploy
   ```

---

## Keyboard & Mouse Shortcuts

| Action | Shortcut / Gesture |
| :--- | :--- |
| **Select Single Shape** | Click on a shape (opens Right Drawer) |
| **Marquee Multi-Select** | Drag on empty canvas background |
| **Add / Remove from Selection** | `Ctrl + Click` (`Cmd + Click`) on a shape |
| **Move Selected Group** | Drag any shape inside the current multi-selection |
| **Delete Selected Shape(s)** | `Delete` or `Backspace` (when not typing in an input) |
| **Undo / Redo** | `Ctrl + Z` / `Ctrl + Y` (or `Ctrl + Shift + Z`) |
| **Zoom In / Out** | `Ctrl + Mouse Wheel` (or bottom-right `+` / `-` buttons) |
| **Cancel Mode / Clear Selection** | `Escape` |

---

## Project Structure

```text
.
├── src/
│   ├── App.tsx          # Flowchart canvas, auto-sort layout, multi-select, Undo/Redo, and drawer UI
│   ├── client.tsx       # React DOM entry point
│   ├── db.ts            # SQLite persistence layer using bun:sqlite
│   ├── defaultData.ts   # Initial sample and minimal flowchart generators
│   ├── index.html       # HTML entry point served by Bun
│   ├── server.ts        # Bun.serve HTTP server & REST API endpoints
│   ├── server.test.ts   # Unit & integration tests (SQLite, layout, bulk delete, group move)
│   ├── styles.css       # Application & canvas styles
│   └── types.ts         # Shared TypeScript interfaces
├── package.json
└── tsconfig.json
```
