# Tigma

A terminal-based design tool for creating ASCII diagrams and designs.

## Running

```bash
bunx tigma
```

Currently this requires [bun](http://bun.sh).

## Usage

```bash
# Start with a blank canvas
bun run index.ts

# Open an existing file
bun run index.ts mydesign.tigma
```

## Tools

Switch between tools using keyboard shortcuts:

| Key | Tool | Description |
|-----|------|-------------|
| `M` | Move | Select, move, and resize objects |
| `T` | Text | Create and edit text boxes |
| `R` | Rectangle | Draw rectangular shapes with box-drawing characters |
| `L` | Line | Draw lines (horizontal, vertical, or diagonal) |

## Controls

### General

| Key | Action |
|-----|--------|
| `Ctrl+S` | Save file (prompts for filename if new) |
| `Ctrl+Z` | Undo |
| `Ctrl+U` | Redo |
| `Delete` / `Backspace` | Delete selected or hovered object(s) |
| `Escape` | Cancel current drawing / exit text editing |

### Move Tool

- **Click** on an object to select it
- **Shift+Click** to add/remove objects from selection (multi-select)
- **Click+Drag** to move selected objects
- **Click on empty space** to deselect all

#### Rectangle Resizing

When a single rectangle is selected and hovered, resize handles appear at:
- Corners (NW, NE, SW, SE)
- Edge midpoints (N, S, E, W)

Drag the handles to resize the rectangle.

#### Layer Ordering

| Key | Action |
|-----|--------|
| `Ctrl+[` | Move selected object down one layer |
| `Ctrl+]` | Move selected object up one layer |

### Text Tool

- **Click** on empty space to create a new text box
- **Click** on existing text to edit it
- **Type** to insert characters at cursor
- **Arrow keys** to move cursor
- `Home` / `End` to jump to start/end
- `Backspace` / `Delete` to remove characters
- `Ctrl+B` to toggle **bold** mode for new characters
- `Escape` to finish editing

### Rectangle Tool

- **Click+Drag** to draw a rectangle
- Release to commit the shape
- Rectangle uses current stroke and fill colors
- Bold mode affects border thickness

### Line Tool

- **Click+Drag** to draw a line
- Supports horizontal, vertical, and diagonal lines
- Uses Bresenham's algorithm for diagonal rendering
- Line uses current stroke color

## Colors

A color picker is displayed at the bottom-right of the canvas.

### Stroke Colors
Controls the color of:
- Text characters
- Rectangle borders
- Lines

Available stroke colors: Transparent, Black, White, Red, Green, Blue, Yellow

### Fill Colors
Controls the background fill of:
- Rectangles (interior area)
- Text boxes (background)

Available fill colors: Transparent, Black, Gray, Muted Red, Muted Green, Muted Blue, Muted Yellow

**Transparent** (shown as `null`) means no color is applied, allowing content beneath to show through.

Click on a color swatch to select it. The selected color applies to:
1. New objects you create
2. Currently selected objects (immediately updates them)

## File Format

Designs are saved as `.tigma` files in JSON format. The file stores:

- Text boxes with per-character styling (bold, color)
- Rectangles with position, stroke color, fill color, and bold state
- Lines with position, stroke color, and bold state
- Z-index ordering for proper layering

## Features

- **Layered rendering**: Objects stack based on z-index; newer objects appear on top by default
- **Multi-selection**: Select multiple objects with Shift+Click
- **Undo/Redo**: Up to 100 history snapshots
- **Terminal responsive**: Adapts to terminal resize events
- **Mouse support**: Full mouse interaction including hover highlighting
- **Live preview**: See rectangles and lines as you draw them

## Example Workflow

1. Press `R` to select the Rectangle tool
2. Click and drag to draw a box
3. Press `T` to select the Text tool
4. Click inside the box and type a label
5. Press `Escape` to finish editing
6. Press `M` to switch to Move tool
7. Select objects and adjust positions
8. Use the color picker to change colors
9. Press `Ctrl+S` to save your work
