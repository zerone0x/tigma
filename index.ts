import {
  createCliRenderer,
  RGBA,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  TextAttributes,
  BoxRenderable,
} from "@opentui/core"
import * as fs from "fs"
import * as path from "path"

// Color can be null for transparent
type EntityColor = RGBA | null

interface TextChar {
  char: string
  bold: boolean
  color: EntityColor  // text color (stroke)
}

interface TextBox {
  id: number
  x: number
  y: number
  chars: TextChar[]
  zIndex: number
  strokeColor: EntityColor
  fillColor: EntityColor
}

interface Rectangle {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
  strokeColor: EntityColor
  fillColor: EntityColor
}

interface Line {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
  strokeColor: EntityColor
  fillColor: EntityColor  // not used for lines, but keeping consistent
}

// Color palette for strokes (bright colors)
const STROKE_PALETTE: (RGBA | null)[] = [
  null, // transparent
  RGBA.fromInts(0, 0, 0, 255),       // black
  RGBA.fromInts(255, 255, 255, 255), // white
  RGBA.fromInts(255, 100, 100, 255), // red
  RGBA.fromInts(100, 255, 100, 255), // green
  RGBA.fromInts(100, 100, 255, 255), // blue
  RGBA.fromInts(255, 255, 100, 255), // yellow
]

// Color palette for fills (muted/darker versions for backgrounds)
const FILL_PALETTE: (RGBA | null)[] = [
  null, // transparent
  RGBA.fromInts(0, 0, 0, 255),       // black
  RGBA.fromInts(60, 60, 60, 255),    // muted white/gray
  RGBA.fromInts(80, 30, 30, 255),    // muted red
  RGBA.fromInts(30, 80, 30, 255),    // muted green
  RGBA.fromInts(30, 30, 80, 255),    // muted blue
  RGBA.fromInts(80, 80, 30, 255),    // muted yellow
]

type Tool = "move" | "text" | "rectangle" | "line"

interface ToolInfo {
  name: string
  key: string
}

const TOOLS: Record<Tool, ToolInfo> = {
  move: { name: "Move", key: "M" },
  text: { name: "Text", key: "T" },
  rectangle: { name: "Rectangle", key: "R" },
  line: { name: "Line", key: "L" }
}

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | null

interface HistorySnapshot {
  textBoxes: TextBox[]
  rectangles: Rectangle[]
  lines: Line[]
  nextTextBoxId: number
  nextRectId: number
  nextLineId: number
  nextZIndex: number
}

// File format for saving/loading designs
interface TigmaFile {
  version: 1
  textBoxes: SerializedTextBox[]
  rectangles: SerializedRectangle[]
  lines: SerializedLine[]
  nextTextBoxId: number
  nextRectId: number
  nextLineId: number
  nextZIndex: number
}

// Serialized versions with colors as arrays instead of RGBA objects
interface SerializedColor {
  r: number
  g: number
  b: number
  a: number
}

interface SerializedTextChar {
  char: string
  bold: boolean
  color: SerializedColor | null
}

interface SerializedTextBox {
  id: number
  x: number
  y: number
  chars: SerializedTextChar[]
  zIndex: number
  strokeColor: SerializedColor | null
  fillColor: SerializedColor | null
}

interface SerializedRectangle {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
  strokeColor: SerializedColor | null
  fillColor: SerializedColor | null
}

interface SerializedLine {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
  strokeColor: SerializedColor | null
  fillColor: SerializedColor | null
}

class CanvasApp {
  private renderer: CliRenderer
  private boldMode = false
  private canvas: BoxRenderable
  private currentFilePath: string | null = null
  private saveStatusMessage: string | null = null
  private saveStatusTimeout: number = 0

  private isSelecting = false
  private isSelectionPending = false

  // Save prompt state
  private showSavePrompt: boolean = false
  private savePromptInput: string = ""

  // Canvas dimensions
  private gridWidth = 0
  private gridHeight = 0

  // Text boxes layer
  private textBoxes: TextBox[] = []
  private nextTextBoxId = 1

  // Rectangle layer
  private rectangles: Rectangle[] = []
  private nextRectId = 1

  // Line layer
  private lines: Line[] = []
  private nextLineId = 1

  // Z-index for layer ordering (higher = on top)
  private nextZIndex = 1

  // Tool state
  private currentTool: Tool = "move"
  private isDrawingRect = false
  private isDrawingLine = false
  private drawStartX = 0
  private drawStartY = 0
  private drawCursorX = 0
  private drawCursorY = 0
  private isDraggingMouse = false

  // Active text box (currently being edited)
  private activeTextBoxId: number | null = null
  private textCursorPos = 0
  private cursorBlinkVisible = true
  private cursorBlinkInterval: ReturnType<typeof setInterval> | null = null

  // Hover state
  private hoveredTextBoxId: number | null = null
  private hoveredRectId: number | null = null
  private hoveredLineId: number | null = null

  // Selection state (persists after clicking/dragging)
  // Using Sets to support multi-selection
  private selectedTextBoxIds: Set<number> = new Set()
  private selectedRectIds: Set<number> = new Set()
  private selectedLineIds: Set<number> = new Set()

  // Dragging state (for moving objects)
  private isDraggingSelection = false
  private dragStartX = 0
  private dragStartY = 0
  private isResizingRect = false
  private resizeHandle: ResizeHandle = null
  private moveOffsetX = 0
  private moveOffsetY = 0
  private mouseDownX = 0
  private mouseDownY = 0
  private hasDragged = false
  private clickedOnSelectedTextBox = false

  // History for undo/redo
  private historyStack: HistorySnapshot[] = []
  private redoStack: HistorySnapshot[] = []
  private readonly MAX_HISTORY = 100

  // Current stroke and fill colors for new entities
  private currentStrokeColor: EntityColor = RGBA.fromInts(255, 255, 255, 255) // white
  private currentFillColor: EntityColor = null // transparent
  private currentStrokeColorIndex = 2 // index in STROKE_PALETTE (white)
  private currentFillColorIndex = 0 // index in FILL_PALETTE (0 = transparent)
  private colorPickerMode: "stroke" | "fill" = "stroke"

  private readonly textColor = RGBA.fromInts(255, 255, 255, 255)
  private readonly bgColor = RGBA.fromInts(0, 0, 0, 255)
  private readonly cursorBgColor = RGBA.fromInts(80, 80, 80, 255)
  private readonly toolbarBgColor = RGBA.fromInts(30, 30, 30, 255)
  private readonly toolbarTextColor = RGBA.fromInts(200, 200, 200, 255)
  private readonly toolbarActiveColor = RGBA.fromInts(100, 150, 255, 255)

  private readonly hoverColor = RGBA.fromInts(35, 40, 60, 255)
  // Selection uses a subtle muted blue
  private readonly selectedBgColor = RGBA.fromInts(25, 40, 80, 255)  // muted blue tint
  private readonly handleColor = RGBA.fromInts(50, 80, 160, 255)  // slightly brighter blue for handles
  private readonly textBoxBorderColor = RGBA.fromInts(100, 150, 255, 255)

  private readonly TOOLBAR_HEIGHT = 1

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.gridWidth = renderer.terminalWidth
    this.gridHeight = renderer.terminalHeight - this.TOOLBAR_HEIGHT

    const self = this

    this.canvas = new BoxRenderable(renderer, {
      id: "canvas",
      width: "100%",
      height: "100%",
      backgroundColor: this.bgColor,
      zIndex: 0,
      onMouse(event: MouseEvent) {
        self.handleMouse(event)
      },
      renderAfter(buffer: OptimizedBuffer) {
        self.render(buffer)
      },
    })

    renderer.root.add(this.canvas)
    this.setupInput()
    this.startCursorBlink()

    renderer.on("resize", (width: number, height: number) => {
      this.handleResize(width, height - this.TOOLBAR_HEIGHT)
    })

    // Clean up resources when the renderer is destroyed (e.g., on Ctrl+C)
    renderer.on("destroy", () => {
      this.cleanup()
    })
  }

  private cleanup(): void {
    if (this.cursorBlinkInterval) {
      clearInterval(this.cursorBlinkInterval)
      this.cursorBlinkInterval = null
    }
  }

  // ==================== Cursor Blink ====================

  private startCursorBlink(): void {
    this.cursorBlinkInterval = setInterval(() => {
      if (this.activeTextBoxId !== null) {
        this.cursorBlinkVisible = !this.cursorBlinkVisible
        this.renderer.requestRender()
      }
    }, 530)
  }

  private resetCursorBlink(): void {
    this.cursorBlinkVisible = true
    this.renderer.requestRender()
  }

  // ==================== Resize ====================

  private handleResize(width: number, height: number): void {
    this.gridWidth = width
    this.gridHeight = height
  }

  // ==================== History (Undo/Redo) ====================

  private saveSnapshot(): void {
    const snapshot: HistorySnapshot = {
      textBoxes: this.cloneTextBoxes(this.textBoxes),
      rectangles: this.cloneRectangles(this.rectangles),
      lines: this.cloneLines(this.lines),
      nextTextBoxId: this.nextTextBoxId,
      nextRectId: this.nextRectId,
      nextLineId: this.nextLineId,
      nextZIndex: this.nextZIndex,
    }
    this.historyStack.push(snapshot)
    if (this.historyStack.length > this.MAX_HISTORY) {
      this.historyStack.shift()
    }
    this.redoStack = []
  }

  private cloneTextBoxes(boxes: TextBox[]): TextBox[] {
    return boxes.map(b => ({ ...b, chars: b.chars.map(c => ({ ...c })) }))
  }

  private cloneRectangles(rects: Rectangle[]): Rectangle[] {
    return rects.map(r => ({ ...r }))
  }

  private cloneLines(lines: Line[]): Line[] {
    return lines.map(l => ({ ...l }))
  }

  private undo(): void {
    if (this.historyStack.length === 0) return

    const currentSnapshot: HistorySnapshot = {
      textBoxes: this.cloneTextBoxes(this.textBoxes),
      rectangles: this.cloneRectangles(this.rectangles),
      lines: this.cloneLines(this.lines),
      nextTextBoxId: this.nextTextBoxId,
      nextRectId: this.nextRectId,
      nextLineId: this.nextLineId,
      nextZIndex: this.nextZIndex,
    }
    this.redoStack.push(currentSnapshot)

    const snapshot = this.historyStack.pop()!
    this.textBoxes = snapshot.textBoxes
    this.rectangles = snapshot.rectangles
    this.lines = snapshot.lines
    this.nextTextBoxId = snapshot.nextTextBoxId
    this.nextRectId = snapshot.nextRectId
    this.nextLineId = snapshot.nextLineId
    this.nextZIndex = snapshot.nextZIndex
    this.activeTextBoxId = null
    this.hoveredTextBoxId = null
    this.hoveredRectId = null
    this.hoveredLineId = null
    this.clearSelection()

    this.renderer.requestRender()
  }

  private redo(): void {
    if (this.redoStack.length === 0) return

    const currentSnapshot: HistorySnapshot = {
      textBoxes: this.cloneTextBoxes(this.textBoxes),
      rectangles: this.cloneRectangles(this.rectangles),
      lines: this.cloneLines(this.lines),
      nextTextBoxId: this.nextTextBoxId,
      nextRectId: this.nextRectId,
      nextLineId: this.nextLineId,
      nextZIndex: this.nextZIndex,
    }
    this.historyStack.push(currentSnapshot)

    const snapshot = this.redoStack.pop()!
    this.textBoxes = snapshot.textBoxes
    this.rectangles = snapshot.rectangles
    this.lines = snapshot.lines
    this.nextTextBoxId = snapshot.nextTextBoxId
    this.nextRectId = snapshot.nextRectId
    this.nextLineId = snapshot.nextLineId
    this.nextZIndex = snapshot.nextZIndex
    this.activeTextBoxId = null
    this.hoveredTextBoxId = null
    this.hoveredRectId = null
    this.hoveredLineId = null
    this.clearSelection()

    this.renderer.requestRender()
  }

  // ==================== File Save/Load ====================

  private serializeColor(color: EntityColor): SerializedColor | null {
    if (color === null) return null
    return { r: color.r, g: color.g, b: color.b, a: color.a }
  }

  private deserializeColor(color: SerializedColor | null): EntityColor {
    if (color === null) return null
    return RGBA.fromValues(color.r, color.g, color.b, color.a)
  }

  private serializeTextBox(box: TextBox): SerializedTextBox {
    return {
      id: box.id,
      x: box.x,
      y: box.y,
      chars: box.chars.map(c => ({
        char: c.char,
        bold: c.bold,
        color: this.serializeColor(c.color),
      })),
      zIndex: box.zIndex,
      strokeColor: this.serializeColor(box.strokeColor),
      fillColor: this.serializeColor(box.fillColor),
    }
  }

  private deserializeTextBox(box: SerializedTextBox): TextBox {
    return {
      id: box.id,
      x: box.x,
      y: box.y,
      chars: box.chars.map(c => ({
        char: c.char,
        bold: c.bold,
        color: this.deserializeColor(c.color),
      })),
      zIndex: box.zIndex,
      strokeColor: this.deserializeColor(box.strokeColor),
      fillColor: this.deserializeColor(box.fillColor),
    }
  }

  private serializeRectangle(rect: Rectangle): SerializedRectangle {
    return {
      id: rect.id,
      x1: rect.x1,
      y1: rect.y1,
      x2: rect.x2,
      y2: rect.y2,
      bold: rect.bold,
      zIndex: rect.zIndex,
      strokeColor: this.serializeColor(rect.strokeColor),
      fillColor: this.serializeColor(rect.fillColor),
    }
  }

  private deserializeRectangle(rect: SerializedRectangle): Rectangle {
    return {
      id: rect.id,
      x1: rect.x1,
      y1: rect.y1,
      x2: rect.x2,
      y2: rect.y2,
      bold: rect.bold,
      zIndex: rect.zIndex,
      strokeColor: this.deserializeColor(rect.strokeColor),
      fillColor: this.deserializeColor(rect.fillColor),
    }
  }

  private serializeLine(line: Line): SerializedLine {
    return {
      id: line.id,
      x1: line.x1,
      y1: line.y1,
      x2: line.x2,
      y2: line.y2,
      bold: line.bold,
      zIndex: line.zIndex,
      strokeColor: this.serializeColor(line.strokeColor),
      fillColor: this.serializeColor(line.fillColor),
    }
  }

  private deserializeLine(line: SerializedLine): Line {
    return {
      id: line.id,
      x1: line.x1,
      y1: line.y1,
      x2: line.x2,
      y2: line.y2,
      bold: line.bold,
      zIndex: line.zIndex,
      strokeColor: this.deserializeColor(line.strokeColor),
      fillColor: this.deserializeColor(line.fillColor),
    }
  }

  private toFileData(): TigmaFile {
    return {
      version: 1,
      textBoxes: this.textBoxes.map(b => this.serializeTextBox(b)),
      rectangles: this.rectangles.map(r => this.serializeRectangle(r)),
      lines: this.lines.map(l => this.serializeLine(l)),
      nextTextBoxId: this.nextTextBoxId,
      nextRectId: this.nextRectId,
      nextLineId: this.nextLineId,
      nextZIndex: this.nextZIndex,
    }
  }

  private loadFromFileData(data: TigmaFile): void {
    this.textBoxes = data.textBoxes.map(b => this.deserializeTextBox(b))
    this.rectangles = data.rectangles.map(r => this.deserializeRectangle(r))
    this.lines = data.lines.map(l => this.deserializeLine(l))
    this.nextTextBoxId = data.nextTextBoxId
    this.nextRectId = data.nextRectId
    this.nextLineId = data.nextLineId
    this.nextZIndex = data.nextZIndex
    
    // Reset UI state
    this.activeTextBoxId = null
    this.hoveredTextBoxId = null
    this.hoveredRectId = null
    this.hoveredLineId = null
    this.clearSelection()
    this.historyStack = []
    this.redoStack = []
    
    this.renderer.requestRender()
  }

  public loadFile(filePath: string): boolean {
    try {
      const absolutePath = path.resolve(filePath)
      const content = fs.readFileSync(absolutePath, "utf-8")
      const data = JSON.parse(content) as TigmaFile
      
      if (data.version !== 1) {
        console.error(`Unsupported file version: ${data.version}`)
        return false
      }
      
      this.loadFromFileData(data)
      this.currentFilePath = absolutePath
      return true
    } catch (err) {
      console.error(`Failed to load file: ${err}`)
      return false
    }
  }

  private saveFile(): void {
    if (this.currentFilePath) {
      // Save directly to the current file
      this.doSaveFile(this.currentFilePath)
    } else {
      // Show prompt to ask for filename
      this.showSavePrompt = true
      this.savePromptInput = "design.tigma"
      this.renderer.requestRender()
    }
  }

  private doSaveFile(filename: string): void {
    try {
      const filePath = path.resolve(filename)
      const data = this.toFileData()
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
      this.currentFilePath = filePath
      this.saveStatusMessage = `Saved to ${path.basename(filePath)}`
      this.saveStatusTimeout = Date.now() + 2000  // Show for 2 seconds
      this.renderer.requestRender()
    } catch (err) {
      this.saveStatusMessage = `Save failed: ${err}`
      this.saveStatusTimeout = Date.now() + 3000
      this.renderer.requestRender()
    }
  }

  private closeSavePrompt(): void {
    this.showSavePrompt = false
    this.savePromptInput = ""
    this.renderer.requestRender()
  }

  private handleSavePromptKey(key: KeyEvent): boolean {
    if (!this.showSavePrompt) return false

    // Let Ctrl+C pass through for exit handling
    if (key.name === "c" && key.ctrl) {
      return false
    }

    if (key.name === "escape") {
      this.closeSavePrompt()
      return true
    }

    if (key.name === "return") {
      const filename = this.savePromptInput.trim() || "design.tigma"
      this.closeSavePrompt()
      this.doSaveFile(filename)
      return true
    }

    if (key.name === "backspace") {
      if (this.savePromptInput.length > 0) {
        this.savePromptInput = this.savePromptInput.slice(0, -1)
        this.renderer.requestRender()
      }
      return true
    }

    // Regular character input
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      this.savePromptInput += key.sequence
      this.renderer.requestRender()
      return true
    }

    return true  // Consume all keys when prompt is open
  }

  // ==================== Selection Helpers ====================

  private clearSelection(): void {
    this.selectedTextBoxIds.clear()
    this.selectedRectIds.clear()
    this.selectedLineIds.clear()
  }

  private hasSelection(): boolean {
    return this.selectedTextBoxIds.size > 0 || this.selectedRectIds.size > 0 || this.selectedLineIds.size > 0
  }

  private isMultiSelection(): boolean {
    const total = this.selectedTextBoxIds.size + this.selectedRectIds.size + this.selectedLineIds.size
    return total > 1
  }

  private getTotalSelectionCount(): number {
    return this.selectedTextBoxIds.size + this.selectedRectIds.size + this.selectedLineIds.size
  }

  private isTextBoxSelected(id: number): boolean {
    return this.selectedTextBoxIds.has(id)
  }

  private isRectSelected(id: number): boolean {
    return this.selectedRectIds.has(id)
  }

  private isLineSelected(id: number): boolean {
    return this.selectedLineIds.has(id)
  }

  private selectTextBox(id: number, addToSelection: boolean): void {
    if (!addToSelection) {
      this.clearSelection()
    }
    this.selectedTextBoxIds.add(id)
  }

  private selectRect(id: number, addToSelection: boolean): void {
    if (!addToSelection) {
      this.clearSelection()
    }
    this.selectedRectIds.add(id)
  }

  private selectLine(id: number, addToSelection: boolean): void {
    if (!addToSelection) {
      this.clearSelection()
    }
    this.selectedLineIds.add(id)
  }

  private moveSelection(dx: number, dy: number): void {
    // Move all selected text boxes
    for (const id of this.selectedTextBoxIds) {
      const box = this.textBoxes.find(b => b.id === id)
      if (box) {
        box.x += dx
        box.y += dy
      }
    }
    // Move all selected rectangles
    for (const id of this.selectedRectIds) {
      const rect = this.rectangles.find(r => r.id === id)
      if (rect) {
        rect.x1 += dx
        rect.y1 += dy
        rect.x2 += dx
        rect.y2 += dy
      }
    }
    // Move all selected lines
    for (const id of this.selectedLineIds) {
      const line = this.lines.find(l => l.id === id)
      if (line) {
        line.x1 += dx
        line.y1 += dy
        line.x2 += dx
        line.y2 += dy
      }
    }
    this.renderer.requestRender()
  }

  // ==================== Mouse Handling ====================

  private handleMouse(event: MouseEvent): void {
    if (event.y >= this.gridHeight) {
      return
    }

    // Check for color picker clicks first
    if (event.type === "down") {
      const colorPickerResult = this.handleColorPickerClick(event.x, event.y)
      if (colorPickerResult) {
        return
      }
    }

    // Handle hover for all tools
    if (event.type === "move") {
      this.updateHover(event.x, event.y)
      return
    }

    // Handle dragging (moving objects)
    if (event.type === "drag") {
      // Track if we've actually moved from the mouse down position
      if (event.x !== this.mouseDownX || event.y !== this.mouseDownY) {
        this.hasDragged = true
      }

      if (this.isSelectionPending && this.hasDragged && this.currentTool === "move") {
        this.isSelectionPending = false
        this.isSelecting = true
        this.isDraggingMouse = true
      }
      
      if (this.isDraggingSelection) {
        // Move all selected items
        const dx = event.x - this.dragStartX
        const dy = event.y - this.dragStartY
        this.moveSelection(dx, dy)
        this.dragStartX = event.x
        this.dragStartY = event.y
      } else if (this.isResizingRect) {
        // Find the single selected rect for resizing
        const rectId = this.selectedRectIds.values().next().value
        if (rectId !== undefined) {
          this.resizeRect(rectId, event.x, event.y)
        }
      } else if (this.isDrawingRect || this.isDrawingLine || this.isSelecting) {
        this.drawCursorX = Math.max(0, Math.min(this.gridWidth - 1, event.x))
        this.drawCursorY = Math.max(0, Math.min(this.gridHeight - 1, event.y))
        this.renderer.requestRender()
      }
      return
    }

    // Handle drag end
    if (event.type === "up" || event.type === "drag-end") {
      if (this.isDrawingRect) {
        this.drawCursorX = Math.max(0, Math.min(this.gridWidth - 1, event.x))
        this.drawCursorY = Math.max(0, Math.min(this.gridHeight - 1, event.y))
        this.commitRectangle()
      }
      if (this.isDrawingLine) {
        this.drawCursorX = Math.max(0, Math.min(this.gridWidth - 1, event.x))
        this.drawCursorY = Math.max(0, Math.min(this.gridHeight - 1, event.y))
        this.commitLine()
      }
      if (this.isSelecting) {
        this.drawCursorX = Math.max(0, Math.min(this.gridWidth - 1, event.x))
        this.drawCursorY = Math.max(0, Math.min(this.gridHeight - 1, event.y))
        this.commitSelection() // 后面会实现这个方法
      }
      
      // If we clicked on a selected text box and didn't drag, enter edit mode (only for single selection)
      if (this.clickedOnSelectedTextBox && !this.hasDragged && this.selectedTextBoxIds.size === 1) {
        const textBoxId = this.selectedTextBoxIds.values().next().value
        const textBox = this.textBoxes.find(b => b.id === textBoxId)
        if (textBox) {
          this.activeTextBoxId = textBox.id
          const relativeX = event.x - textBox.x
          this.textCursorPos = Math.min(relativeX, this.getTextLength(textBox))
          this.clearSelection()
          this.resetCursorBlink()
          this.renderer.requestRender()
        }
      }
      
      this.isDraggingSelection = false
      this.isResizingRect = false
      this.resizeHandle = null
      this.isDraggingMouse = false
      this.clickedOnSelectedTextBox = false
      this.hasDragged = false
      this.isSelecting = false
      this.isSelectionPending = false

      return
    }

    // Handle mouse down
    if (event.type === "down") {
      // If editing text, check if clicking on same text box or elsewhere
      if (this.activeTextBoxId !== null) {
        const activeBox = this.textBoxes.find(b => b.id === this.activeTextBoxId)
        if (activeBox) {
          const boxWidth = Math.max(1, this.getTextLength(activeBox))
          const clickedOnActiveBox = event.x >= activeBox.x && event.x < activeBox.x + boxWidth && event.y === activeBox.y
          
          if (clickedOnActiveBox) {
            // Move cursor within the text box
            const relativeX = event.x - activeBox.x
            this.textCursorPos = Math.min(relativeX, this.getTextLength(activeBox))
            this.resetCursorBlink()
            this.renderer.requestRender()
            return
          }
        }
        
        // Clicked outside - commit text and switch to Move tool
        this.commitActiveTextBox()
        this.setTool("move")
        // Don't return - continue to handle the click in Move mode
      }

      // Move tool: select and move existing objects
      if (this.currentTool === "move") {
        // Track mouse down position for detecting clicks vs drags
        this.mouseDownX = event.x
        this.mouseDownY = event.y
        this.hasDragged = false
        this.clickedOnSelectedTextBox = false
        
        const shiftHeld = event.modifiers?.shift ?? false
        
        // First check if clicking on a SELECTED rectangle's resize handle (only for single selection)
        if (this.selectedRectIds.size === 1 && !this.isMultiSelection()) {
          const rectId = this.selectedRectIds.values().next().value
          if (rectId !== undefined) {
            const handle = this.getResizeHandleAt(rectId, event.x, event.y)
            if (handle) {
              this.saveSnapshot()
              this.isResizingRect = true
              this.resizeHandle = handle
              this.isDraggingMouse = true
              return
            }
          }
        }

        // Check if clicking on a text box
        const clickedTextBox = this.getTextBoxAt(event.x, event.y)
        if (clickedTextBox) {
          const alreadySelected = this.isTextBoxSelected(clickedTextBox.id)
          
          if (alreadySelected && !shiftHeld && !this.isMultiSelection()) {
            // Single selected text box clicked again - prepare for edit mode
            this.clickedOnSelectedTextBox = true
          }
          
          if (shiftHeld) {
            // Toggle selection
            if (alreadySelected) {
              this.selectedTextBoxIds.delete(clickedTextBox.id)
            } else {
              this.selectedTextBoxIds.add(clickedTextBox.id)
            }
          } else if (!alreadySelected) {
            // Regular click on unselected - select only this
            this.selectTextBox(clickedTextBox.id, false)
          }
          
          // Prepare for dragging all selected items
          this.saveSnapshot()
          this.isDraggingSelection = true
          this.dragStartX = event.x
          this.dragStartY = event.y
          this.isDraggingMouse = true
          this.renderer.requestRender()
          return
        }

        // Check if clicking on a rectangle
        const clickedRect = this.getRectangleAt(event.x, event.y)
        if (clickedRect) {
          const alreadySelected = this.isRectSelected(clickedRect.id)
          
          if (shiftHeld) {
            // Toggle selection
            if (alreadySelected) {
              this.selectedRectIds.delete(clickedRect.id)
            } else {
              this.selectedRectIds.add(clickedRect.id)
            }
          } else if (!alreadySelected) {
            // Regular click on unselected - select only this
            this.selectRect(clickedRect.id, false)
          }
          
          // Prepare for dragging all selected items
          this.saveSnapshot()
          this.isDraggingSelection = true
          this.dragStartX = event.x
          this.dragStartY = event.y
          this.isDraggingMouse = true
          this.renderer.requestRender()
          return
        }

        // Check if clicking on a line
        const clickedLine = this.getLineAt(event.x, event.y)
        if (clickedLine) {
          const alreadySelected = this.isLineSelected(clickedLine.id)
          
          if (shiftHeld) {
            // Toggle selection
            if (alreadySelected) {
              this.selectedLineIds.delete(clickedLine.id)
            } else {
              this.selectedLineIds.add(clickedLine.id)
            }
          } else if (!alreadySelected) {
            // Regular click on unselected - select only this
            this.selectLine(clickedLine.id, false)
          }
          
          // Prepare for dragging all selected items
          this.saveSnapshot()
          this.isDraggingSelection = true
          this.dragStartX = event.x
          this.dragStartY = event.y
          this.isDraggingMouse = true
          this.renderer.requestRender()
          return
        }

        // Clicking on empty space - clear selection (unless shift is held) and prep box selection
        if (!shiftHeld) {
          this.clearSelection()
        }
        this.isSelectionPending = true
        this.drawStartX = event.x
        this.drawStartY = event.y
        this.drawCursorX = event.x
        this.drawCursorY = event.y
        this.renderer.requestRender()
        return
      }

      // Drawing tools: create new objects (ignore existing objects)
      // Clear selection when using drawing tools
      this.clearSelection()

      if (this.currentTool === "text") {
        // Check if clicking on an existing text box to edit it
        const clickedTextBox = this.getTextBoxAt(event.x, event.y)
        if (clickedTextBox) {
          // Start editing this text box
          this.activeTextBoxId = clickedTextBox.id
          const relativeX = event.x - clickedTextBox.x
          this.textCursorPos = Math.min(relativeX, this.getTextLength(clickedTextBox))
          this.resetCursorBlink()
        } else {
          // Create a new text box
          this.saveSnapshot()
          const newBox: TextBox = {
            id: this.nextTextBoxId++,
            x: event.x,
            y: event.y,
            chars: [],
            zIndex: this.nextZIndex++,
            strokeColor: this.currentStrokeColor,
            fillColor: null,  // Text always starts with transparent fill
          }
          this.textBoxes.push(newBox)
          this.activeTextBoxId = newBox.id
          this.textCursorPos = 0
          this.resetCursorBlink()
        }
      } else if (this.currentTool === "rectangle") {
        // Start drawing rectangle
        this.isDrawingRect = true
        this.isDraggingMouse = true
        this.drawStartX = event.x
        this.drawStartY = event.y
        this.drawCursorX = event.x
        this.drawCursorY = event.y
      } else if (this.currentTool === "line") {
        // Start drawing line
        this.isDrawingLine = true
        this.isDraggingMouse = true
        this.drawStartX = event.x
        this.drawStartY = event.y
        this.drawCursorX = event.x
        this.drawCursorY = event.y
      }

      this.renderer.requestRender()
    }
  }

  private updateHover(x: number, y: number): void {
    const oldHoveredTextBox = this.hoveredTextBoxId
    const oldHoveredRect = this.hoveredRectId
    const oldHoveredLine = this.hoveredLineId

    // Only show hover highlighting when move tool is active
    if (this.currentTool !== "move") {
      this.hoveredTextBoxId = null
      this.hoveredRectId = null
      this.hoveredLineId = null
    } else {
      // If hovering over a selected rectangle's resize handle (single selection only), 
      // keep that rect as hovered but don't show hover on other objects
      if (this.selectedRectIds.size === 1 && !this.isMultiSelection()) {
        const rectId = this.selectedRectIds.values().next().value
        if (rectId !== undefined) {
          const handle = this.getResizeHandleAt(rectId, x, y)
          if (handle) {
            this.hoveredTextBoxId = null
            this.hoveredRectId = rectId  // Keep the rect hovered so handles show
            this.hoveredLineId = null
            // Re-render if hover state changed
            if (oldHoveredTextBox !== null || oldHoveredRect !== rectId || oldHoveredLine !== null) {
              this.renderer.requestRender()
            }
            return
          }
        }
      }

      // Find the object at this position with the highest zIndex
      const textBox = this.getTextBoxAt(x, y)
      const rect = this.getRectangleAt(x, y)
      const line = this.getLineAt(x, y)
      
      // Determine which object has the highest zIndex
      let highestZ = -1
      let highestType: "text" | "rect" | "line" | null = null
      
      if (textBox && textBox.zIndex > highestZ) {
        highestZ = textBox.zIndex
        highestType = "text"
      }
      if (rect && rect.zIndex > highestZ) {
        highestZ = rect.zIndex
        highestType = "rect"
      }
      if (line && line.zIndex > highestZ) {
        highestZ = line.zIndex
        highestType = "line"
      }
      
      this.hoveredTextBoxId = highestType === "text" ? textBox!.id : null
      this.hoveredRectId = highestType === "rect" ? rect!.id : null
      this.hoveredLineId = highestType === "line" ? line!.id : null
    }

    // Only re-render if hover state changed
    if (this.hoveredTextBoxId !== oldHoveredTextBox || this.hoveredRectId !== oldHoveredRect || this.hoveredLineId !== oldHoveredLine) {
      this.renderer.requestRender()
    }
  }

  // ==================== Text Box Operations ====================

  private getTextLength(box: TextBox): number {
    return box.chars.length
  }

  private getTextBoxAt(x: number, y: number): TextBox | null {
    let found: TextBox | null = null
    for (const box of this.textBoxes) {
      const boxWidth = Math.max(1, this.getTextLength(box))
      if (x >= box.x && x < box.x + boxWidth && y === box.y) {
        if (!found || box.zIndex > found.zIndex) {
          found = box
        }
      }
    }
    return found
  }

  private commitActiveTextBox(): void {
    if (this.activeTextBoxId === null) return
    
    const box = this.textBoxes.find(b => b.id === this.activeTextBoxId)
    if (box && this.getTextLength(box) === 0) {
      this.textBoxes = this.textBoxes.filter(b => b.id !== this.activeTextBoxId)
    }
    this.activeTextBoxId = null
    this.textCursorPos = 0
  }

  private moveTextBox(id: number, newX: number, newY: number): void {
    const box = this.textBoxes.find(b => b.id === id)
    if (!box) return

    newX = Math.max(0, Math.min(this.gridWidth - Math.max(1, this.getTextLength(box)), newX))
    newY = Math.max(0, Math.min(this.gridHeight - 1, newY))

    box.x = newX
    box.y = newY
    this.renderer.requestRender()
  }

  private deleteTextBox(id: number): void {
    this.saveSnapshot()
    this.textBoxes = this.textBoxes.filter(b => b.id !== id)
    if (this.activeTextBoxId === id) {
      this.activeTextBoxId = null
    }
    if (this.hoveredTextBoxId === id) {
      this.hoveredTextBoxId = null
    }
    this.renderer.requestRender()
  }

  // ==================== Rectangle Operations ====================

  private getRectangleAt(x: number, y: number): Rectangle | null {
    let found: Rectangle | null = null
    for (const rect of this.rectangles) {
      if (this.isOnRectBorder(x, y, rect)) {
        if (!found || rect.zIndex > found.zIndex) {
          found = rect
        }
      }
    }
    return found
  }

  private isOnRectBorder(x: number, y: number, rect: Rectangle): boolean {
    const { x1, y1, x2, y2 } = this.normalizeRect(rect)
    const onTopOrBottom = (y === y1 || y === y2) && x >= x1 && x <= x2
    const onLeftOrRight = (x === x1 || x === x2) && y >= y1 && y <= y2
    return onTopOrBottom || onLeftOrRight
  }

  private normalizeRect(rect: Rectangle): { x1: number; y1: number; x2: number; y2: number } {
    return {
      x1: Math.min(rect.x1, rect.x2),
      y1: Math.min(rect.y1, rect.y2),
      x2: Math.max(rect.x1, rect.x2),
      y2: Math.max(rect.y1, rect.y2),
    }
  }

  private getResizeHandleAt(rectId: number, x: number, y: number): ResizeHandle {
    const rect = this.rectangles.find(r => r.id === rectId)
    if (!rect) return null

    const { x1, y1, x2, y2 } = this.normalizeRect(rect)

    if (x === x1 && y === y1) return "nw"
    if (x === x2 && y === y1) return "ne"
    if (x === x1 && y === y2) return "sw"
    if (x === x2 && y === y2) return "se"

    const midX = Math.floor((x1 + x2) / 2)
    const midY = Math.floor((y1 + y2) / 2)
    if (x === midX && y === y1) return "n"
    if (x === midX && y === y2) return "s"
    if (x === x1 && y === midY) return "w"
    if (x === x2 && y === midY) return "e"

    return null
  }

  private moveRect(id: number, newX: number, newY: number): void {
    const rect = this.rectangles.find(r => r.id === id)
    if (!rect) return

    const normalized = this.normalizeRect(rect)
    const width = normalized.x2 - normalized.x1
    const height = normalized.y2 - normalized.y1

    newX = Math.max(0, Math.min(this.gridWidth - width - 1, newX))
    newY = Math.max(0, Math.min(this.gridHeight - height - 1, newY))

    rect.x1 = newX
    rect.y1 = newY
    rect.x2 = newX + width
    rect.y2 = newY + height

    this.renderer.requestRender()
  }

  private resizeRect(id: number, mouseX: number, mouseY: number): void {
    const rect = this.rectangles.find(r => r.id === id)
    if (!rect || !this.resizeHandle) return

    mouseX = Math.max(0, Math.min(this.gridWidth - 1, mouseX))
    mouseY = Math.max(0, Math.min(this.gridHeight - 1, mouseY))

    switch (this.resizeHandle) {
      case "nw": rect.x1 = mouseX; rect.y1 = mouseY; break
      case "ne": rect.x2 = mouseX; rect.y1 = mouseY; break
      case "sw": rect.x1 = mouseX; rect.y2 = mouseY; break
      case "se": rect.x2 = mouseX; rect.y2 = mouseY; break
      case "n": rect.y1 = mouseY; break
      case "s": rect.y2 = mouseY; break
      case "w": rect.x1 = mouseX; break
      case "e": rect.x2 = mouseX; break
    }

    this.renderer.requestRender()
  }

  private commitRectangle(): void {
    if (!this.isDrawingRect) return

    const x1 = Math.min(this.drawStartX, this.drawCursorX)
    const x2 = Math.max(this.drawStartX, this.drawCursorX)
    const y1 = Math.min(this.drawStartY, this.drawCursorY)
    const y2 = Math.max(this.drawStartY, this.drawCursorY)

    if (x2 > x1 || y2 > y1) {
      this.saveSnapshot()
      const rect: Rectangle = {
        id: this.nextRectId++,
        x1, y1, x2, y2,
        bold: this.boldMode,
        zIndex: this.nextZIndex++,
        strokeColor: this.currentStrokeColor,
        fillColor: this.currentFillColor,
      }
      this.rectangles.push(rect)
      // Select the newly created rectangle
      this.selectRect(rect.id, false)
    }

    this.isDrawingRect = false
    // Switch back to Move tool after drawing
    this.setTool("move")
  }

  private deleteRect(id: number): void {
    this.saveSnapshot()
    this.rectangles = this.rectangles.filter(r => r.id !== id)
    if (this.hoveredRectId === id) {
      this.hoveredRectId = null
    }
    this.renderer.requestRender()
  }

  // ==================== Line Operations ====================

  private getLineAt(x: number, y: number): Line | null {
    let found: Line | null = null
    for (const line of this.lines) {
      if (this.isOnLine(x, y, line)) {
        if (!found || line.zIndex > found.zIndex) {
          found = line
        }
      }
    }
    return found
  }

  private isOnLine(x: number, y: number, line: Line): boolean {
    const { x1, y1, x2, y2 } = this.normalizeLine(line)
    
    // Check if point is on the line segment
    if (x1 === x2) {
      // Vertical line
      return x === x1 && y >= y1 && y <= y2
    } else if (y1 === y2) {
      // Horizontal line
      return y === y1 && x >= x1 && x <= x2
    } else {
      // Diagonal line - check if point is on any of the cells the line passes through
      const points = this.getLinePoints(x1, y1, x2, y2)
      return points.some(p => p.x === x && p.y === y)
    }
  }

  private normalizeLine(line: Line): { x1: number; y1: number; x2: number; y2: number } {
    // For lines, we keep the original direction but ensure consistent ordering for bounds
    return {
      x1: Math.min(line.x1, line.x2),
      y1: Math.min(line.y1, line.y2),
      x2: Math.max(line.x1, line.x2),
      y2: Math.max(line.y1, line.y2),
    }
  }

  private getLinePoints(x1: number, y1: number, x2: number, y2: number): { x: number; y: number }[] {
    // Bresenham's line algorithm
    const points: { x: number; y: number }[] = []
    const dx = Math.abs(x2 - x1)
    const dy = Math.abs(y2 - y1)
    const sx = x1 < x2 ? 1 : -1
    const sy = y1 < y2 ? 1 : -1
    let err = dx - dy
    let x = x1
    let y = y1

    while (true) {
      points.push({ x, y })
      if (x === x2 && y === y2) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
    return points
  }

  private moveLine(id: number, newX: number, newY: number): void {
    const line = this.lines.find(l => l.id === id)
    if (!line) return

    const normalized = this.normalizeLine(line)
    const width = normalized.x2 - normalized.x1
    const height = normalized.y2 - normalized.y1

    newX = Math.max(0, Math.min(this.gridWidth - width - 1, newX))
    newY = Math.max(0, Math.min(this.gridHeight - height - 1, newY))

    const dx = newX - normalized.x1
    const dy = newY - normalized.y1

    line.x1 += dx
    line.y1 += dy
    line.x2 += dx
    line.y2 += dy

    this.renderer.requestRender()
  }

  private commitLine(): void {
    if (!this.isDrawingLine) return

    const x1 = this.drawStartX
    const y1 = this.drawStartY
    const x2 = this.drawCursorX
    const y2 = this.drawCursorY

    // Only create line if it has some length
    if (x1 !== x2 || y1 !== y2) {
      this.saveSnapshot()
      const line: Line = {
        id: this.nextLineId++,
        x1, y1, x2, y2,
        bold: this.boldMode,
        zIndex: this.nextZIndex++,
        strokeColor: this.currentStrokeColor,
        fillColor: null,  // Lines don't use fill
      }
      this.lines.push(line)
      // Select the newly created line
      this.selectLine(line.id, false)
    }

    this.isDrawingLine = false
    // Switch back to Move tool after drawing
    this.setTool("move")
  }

  private commitSelection(): void {
    if (!this.isSelecting) return

    const selX1 = Math.min(this.drawStartX, this.drawCursorX)
    const selX2 = Math.max(this.drawStartX, this.drawCursorX)
    const selY1 = Math.min(this.drawStartY, this.drawCursorY)
    const selY2 = Math.max(this.drawStartY, this.drawCursorY)

    const isIntersecting = (x1: number, y1: number, x2: number, y2: number) => {
      return !(x2 < selX1 || x1 > selX2 || y2 < selY1 || y1 > selY2)
    }

    for (const box of this.textBoxes) {
      const width = Math.max(1, this.getTextLength(box))
      const bx1 = box.x
      const bx2 = box.x + width - 1
      const by1 = box.y
      const by2 = box.y
      
      if (isIntersecting(bx1, by1, bx2, by2)) {
        this.selectTextBox(box.id, true)
      }
    }

    for (const rect of this.rectangles) {
      const { x1, y1, x2, y2 } = this.normalizeRect(rect)
      if (isIntersecting(x1, y1, x2, y2)) {
        this.selectRect(rect.id, true)
      }
    }

    for (const line of this.lines) {
      const { x1, y1, x2, y2 } = this.normalizeLine(line)
      if (isIntersecting(x1, y1, x2, y2)) {
        this.selectLine(line.id, true)
      }
    }

    this.isSelecting = false
  }

  private deleteLine(id: number): void {
    this.saveSnapshot()
    this.lines = this.lines.filter(l => l.id !== id)
    if (this.hoveredLineId === id) {
      this.hoveredLineId = null
    }
    this.renderer.requestRender()
  }

  // ==================== Layer Management ====================

  private getSelectedObject(): { type: "text" | "rect" | "line"; zIndex: number; id: number } | null {
    // Only return a single selected object (for layer reordering - only works with single selection)
    if (this.selectedTextBoxIds.size === 1) {
      const id = this.selectedTextBoxIds.values().next().value
      const box = this.textBoxes.find(b => b.id === id)
      if (box) return { type: "text", zIndex: box.zIndex, id: box.id }
    }
    if (this.selectedRectIds.size === 1) {
      const id = this.selectedRectIds.values().next().value
      const rect = this.rectangles.find(r => r.id === id)
      if (rect) return { type: "rect", zIndex: rect.zIndex, id: rect.id }
    }
    if (this.selectedLineIds.size === 1) {
      const id = this.selectedLineIds.values().next().value
      const line = this.lines.find(l => l.id === id)
      if (line) return { type: "line", zIndex: line.zIndex, id: line.id }
    }
    return null
  }

  private getAllZIndices(): number[] {
    const indices: number[] = []
    for (const box of this.textBoxes) indices.push(box.zIndex)
    for (const rect of this.rectangles) indices.push(rect.zIndex)
    for (const line of this.lines) indices.push(line.zIndex)
    return indices.sort((a, b) => a - b)
  }

  private moveLayerDown(): void {
    const selected = this.getSelectedObject()
    if (!selected) return

    const allZIndices = this.getAllZIndices()
    const currentIndex = allZIndices.indexOf(selected.zIndex)
    
    // Find the next lower zIndex
    if (currentIndex <= 0) return // Already at bottom
    
    const lowerZ = allZIndices[currentIndex - 1]!
    
    this.saveSnapshot()
    
    // Swap zIndex values
    // Find the object with lowerZ and give it our zIndex
    for (const box of this.textBoxes) {
      if (box.zIndex === lowerZ) {
        box.zIndex = selected.zIndex
        break
      }
    }
    for (const rect of this.rectangles) {
      if (rect.zIndex === lowerZ) {
        rect.zIndex = selected.zIndex
        break
      }
    }
    for (const line of this.lines) {
      if (line.zIndex === lowerZ) {
        line.zIndex = selected.zIndex
        break
      }
    }
    
    // Give the selected object the lower zIndex
    if (selected.type === "text") {
      const box = this.textBoxes.find(b => b.id === selected.id)
      if (box) box.zIndex = lowerZ
    } else if (selected.type === "rect") {
      const rect = this.rectangles.find(r => r.id === selected.id)
      if (rect) rect.zIndex = lowerZ
    } else if (selected.type === "line") {
      const line = this.lines.find(l => l.id === selected.id)
      if (line) line.zIndex = lowerZ
    }
    
    this.renderer.requestRender()
  }

  private moveLayerUp(): void {
    const selected = this.getSelectedObject()
    if (!selected) return

    const allZIndices = this.getAllZIndices()
    const currentIndex = allZIndices.indexOf(selected.zIndex)
    
    // Find the next higher zIndex
    if (currentIndex >= allZIndices.length - 1) return // Already at top
    
    const higherZ = allZIndices[currentIndex + 1]!
    
    this.saveSnapshot()
    
    // Swap zIndex values
    // Find the object with higherZ and give it our zIndex
    for (const box of this.textBoxes) {
      if (box.zIndex === higherZ) {
        box.zIndex = selected.zIndex
        break
      }
    }
    for (const rect of this.rectangles) {
      if (rect.zIndex === higherZ) {
        rect.zIndex = selected.zIndex
        break
      }
    }
    for (const line of this.lines) {
      if (line.zIndex === higherZ) {
        line.zIndex = selected.zIndex
        break
      }
    }
    
    // Give the selected object the higher zIndex
    if (selected.type === "text") {
      const box = this.textBoxes.find(b => b.id === selected.id)
      if (box) box.zIndex = higherZ
    } else if (selected.type === "rect") {
      const rect = this.rectangles.find(r => r.id === selected.id)
      if (rect) rect.zIndex = higherZ
    } else if (selected.type === "line") {
      const line = this.lines.find(l => l.id === selected.id)
      if (line) line.zIndex = higherZ
    }
    
    this.renderer.requestRender()
  }

  // ==================== Tool Management ====================

  private toggleBold(): void {
    this.boldMode = !this.boldMode
    this.renderer.requestRender()
  }

  private setTool(tool: Tool): void {
    if (this.activeTextBoxId !== null) {
      this.commitActiveTextBox()
    }
    
    this.isDrawingRect = false
    this.isDrawingLine = false
    this.isSelecting = false
    this.isSelectionPending = false
    this.isDraggingMouse = false
    this.currentTool = tool
    
    // Clear hover and selection state when switching away from move tool
    if (tool !== "move") {
      this.hoveredTextBoxId = null
      this.hoveredRectId = null
      this.hoveredLineId = null
      this.clearSelection()
    }
    
    this.renderer.requestRender()
  }

  // ==================== Rendering ====================

  private render(buffer: OptimizedBuffer): void {
    const height = Math.min(this.gridHeight, buffer.height - this.TOOLBAR_HEIGHT)
    const width = Math.min(this.gridWidth, buffer.width)

    // Clear background
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        buffer.setCell(x, y, " ", this.textColor, this.bgColor, 0)
      }
    }

    // Collect all objects with their zIndex for proper layering
    type RenderItem = 
      | { type: "text"; obj: TextBox }
      | { type: "rect"; obj: Rectangle }
      | { type: "line"; obj: Line }
    
    const items: RenderItem[] = [
      ...this.textBoxes.map(obj => ({ type: "text" as const, obj })),
      ...this.rectangles.map(obj => ({ type: "rect" as const, obj })),
      ...this.lines.map(obj => ({ type: "line" as const, obj })),
    ]
    
    // Sort by zIndex (lower first, so higher zIndex renders on top)
    items.sort((a, b) => a.obj.zIndex - b.obj.zIndex)

    // Render all objects in zIndex order
    for (const item of items) {
      if (item.type === "text") {
        const isSelected = this.isTextBoxSelected(item.obj.id)
        const isHovered = item.obj.id === this.hoveredTextBoxId && item.obj.id !== this.activeTextBoxId && !isSelected
        this.renderTextBox(buffer, item.obj, isHovered, isSelected)
      } else if (item.type === "rect") {
        const isSelected = this.isRectSelected(item.obj.id)
        const isHovered = item.obj.id === this.hoveredRectId && !isSelected
        this.renderRectangle(buffer, item.obj, isHovered, false)
      } else if (item.type === "line") {
        const isSelected = this.isLineSelected(item.obj.id)
        const isHovered = item.obj.id === this.hoveredLineId && !isSelected
        this.renderLine(buffer, item.obj, isHovered, false)
      }
    }

    // Draw previews (while drawing) - always on top
    if (this.isDrawingRect) {
      this.renderRectanglePreview(buffer)
    }
    if (this.isDrawingLine) {
      this.renderLinePreview(buffer)
    }
    if (this.isSelecting) {
      this.renderSelectionBoxPreview(buffer)
    }


    // Draw active text box border and cursor - on top of everything
    if (this.activeTextBoxId !== null) {
      const activeBox = this.textBoxes.find(b => b.id === this.activeTextBoxId)
      if (activeBox) {
        this.renderTextBoxBorder(buffer, activeBox, this.textBoxBorderColor)
        this.renderTextCursor(buffer, activeBox)
      }
    }

    // Draw selection highlights ON TOP of everything
    // These read the current buffer content and only change the background color
    for (const id of this.selectedTextBoxIds) {
      const selectedTextBox = this.textBoxes.find(b => b.id === id)
      if (selectedTextBox) {
        // Render selection with 1-cell border around text
        const textWidth = Math.max(1, selectedTextBox.chars.length)
        this.renderSelectionHighlight(buffer, selectedTextBox.x - 1, selectedTextBox.y - 1, textWidth + 2, 3)
      }
    }
    for (const id of this.selectedRectIds) {
      const selectedRect = this.rectangles.find(r => r.id === id)
      if (selectedRect) {
        // Only show resize handles when hovered and single selection
        const isHovered = this.hoveredRectId === id
        const showHandles = isHovered && !this.isMultiSelection()
        this.renderRectangleSelectionHighlight(buffer, selectedRect, showHandles)
      }
    }
    for (const id of this.selectedLineIds) {
      const selectedLine = this.lines.find(l => l.id === id)
      if (selectedLine) {
        this.renderLineSelectionHighlight(buffer, selectedLine)
      }
    }

    // Draw color picker (in bottom right, above toolbar)
    this.renderColorPicker(buffer)

    // Draw toolbar
    this.renderToolbar(buffer)

    // Draw save prompt modal if active
    if (this.showSavePrompt) {
      this.renderSavePrompt(buffer)
    }
  }

  private renderSavePrompt(buffer: OptimizedBuffer): void {
    const promptWidth = 40
    const promptHeight = 5
    const startX = Math.floor((this.gridWidth - promptWidth) / 2)
    const startY = Math.floor((this.gridHeight - promptHeight) / 2)
    
    const borderColor = RGBA.fromInts(100, 150, 255, 255)
    const bgColor = RGBA.fromInts(20, 20, 30, 255)
    const textColor = RGBA.fromInts(255, 255, 255, 255)
    const inputBgColor = RGBA.fromInts(40, 40, 50, 255)
    
    // Draw background
    for (let y = startY; y < startY + promptHeight; y++) {
      for (let x = startX; x < startX + promptWidth; x++) {
        if (x >= 0 && x < this.gridWidth && y >= 0 && y < this.gridHeight) {
          buffer.setCell(x, y, " ", textColor, bgColor, 0)
        }
      }
    }
    
    // Draw border
    for (let x = startX; x < startX + promptWidth; x++) {
      if (x >= 0 && x < this.gridWidth) {
        if (startY >= 0 && startY < this.gridHeight) {
          buffer.setCell(x, startY, "─", borderColor, bgColor, 0)
        }
        if (startY + promptHeight - 1 >= 0 && startY + promptHeight - 1 < this.gridHeight) {
          buffer.setCell(x, startY + promptHeight - 1, "─", borderColor, bgColor, 0)
        }
      }
    }
    for (let y = startY; y < startY + promptHeight; y++) {
      if (y >= 0 && y < this.gridHeight) {
        if (startX >= 0 && startX < this.gridWidth) {
          buffer.setCell(startX, y, "│", borderColor, bgColor, 0)
        }
        if (startX + promptWidth - 1 >= 0 && startX + promptWidth - 1 < this.gridWidth) {
          buffer.setCell(startX + promptWidth - 1, y, "│", borderColor, bgColor, 0)
        }
      }
    }
    // Corners
    if (startX >= 0 && startY >= 0) buffer.setCell(startX, startY, "┌", borderColor, bgColor, 0)
    if (startX + promptWidth - 1 < this.gridWidth && startY >= 0) buffer.setCell(startX + promptWidth - 1, startY, "┐", borderColor, bgColor, 0)
    if (startX >= 0 && startY + promptHeight - 1 < this.gridHeight) buffer.setCell(startX, startY + promptHeight - 1, "└", borderColor, bgColor, 0)
    if (startX + promptWidth - 1 < this.gridWidth && startY + promptHeight - 1 < this.gridHeight) buffer.setCell(startX + promptWidth - 1, startY + promptHeight - 1, "┘", borderColor, bgColor, 0)
    
    // Draw title
    const title = " Save As "
    const titleX = startX + Math.floor((promptWidth - title.length) / 2)
    for (let i = 0; i < title.length; i++) {
      if (titleX + i >= 0 && titleX + i < this.gridWidth && startY >= 0 && startY < this.gridHeight) {
        buffer.setCell(titleX + i, startY, title[i]!, borderColor, bgColor, 0)
      }
    }
    
    // Draw input field background
    const inputY = startY + 2
    const inputX = startX + 2
    const inputWidth = promptWidth - 4
    for (let x = inputX; x < inputX + inputWidth; x++) {
      if (x >= 0 && x < this.gridWidth && inputY >= 0 && inputY < this.gridHeight) {
        buffer.setCell(x, inputY, " ", textColor, inputBgColor, 0)
      }
    }
    
    // Draw input text
    const displayText = this.savePromptInput.slice(-(inputWidth - 1))  // Show end if too long
    for (let i = 0; i < displayText.length; i++) {
      if (inputX + i >= 0 && inputX + i < this.gridWidth && inputY >= 0 && inputY < this.gridHeight) {
        buffer.setCell(inputX + i, inputY, displayText[i]!, textColor, inputBgColor, 0)
      }
    }
    
    // Draw cursor
    const cursorX = inputX + displayText.length
    if (cursorX >= 0 && cursorX < inputX + inputWidth && inputY >= 0 && inputY < this.gridHeight) {
      buffer.setCell(cursorX, inputY, "▏", borderColor, inputBgColor, 0)
    }
    
    // Draw hint
    const hint = "Enter to save, Esc to cancel"
    const hintX = startX + Math.floor((promptWidth - hint.length) / 2)
    const hintY = startY + promptHeight - 2
    const hintColor = RGBA.fromInts(150, 150, 150, 255)
    for (let i = 0; i < hint.length; i++) {
      if (hintX + i >= 0 && hintX + i < this.gridWidth && hintY >= 0 && hintY < this.gridHeight) {
        buffer.setCell(hintX + i, hintY, hint[i]!, hintColor, bgColor, 0)
      }
    }
  }

  private renderTextBox(buffer: OptimizedBuffer, box: TextBox, isHovered: boolean, isSelected: boolean = false): void {
    const boxWidth = Math.max(1, box.chars.length)

    for (let i = 0; i < boxWidth; i++) {
      const x = box.x + i
      if (x >= 0 && x < this.gridWidth && box.y >= 0 && box.y < this.gridHeight) {
        // Determine background: selection > hover > fill > existing buffer bg
        let bg: RGBA
        if (isSelected) {
          bg = this.getSelectionBg(x, box.y)
        } else if (isHovered) {
          bg = this.hoverColor
        } else if (box.fillColor !== null) {
          bg = box.fillColor
        } else {
          // Transparent fill - use whatever is already in the buffer
          bg = this.readBufferBg(buffer, x, box.y)
        }
        
        if (i < box.chars.length) {
          const charInfo = box.chars[i]!
          // Use per-character color if set, otherwise fall back to box strokeColor, then default
          const charColor = charInfo.color ?? box.strokeColor ?? this.textColor
          const fg = charColor
          const attrs = charInfo.bold ? TextAttributes.BOLD : 0
          buffer.setCell(x, box.y, charInfo.char, fg, bg, attrs)
        } else if (isHovered || isSelected) {
          buffer.setCell(x, box.y, " ", this.textColor, bg, 0)
        }
      }
    }
  }

  private renderTextBoxBorder(buffer: OptimizedBuffer, box: TextBox, borderColor: RGBA): void {
    const boxWidth = Math.max(1, box.chars.length)
    const x1 = box.x - 1
    const x2 = box.x + boxWidth
    const y1 = box.y - 1
    const y2 = box.y + 1

    const drawBorderCell = (x: number, y: number, char: string) => {
      if (x >= 0 && x < this.gridWidth && y >= 0 && y < this.gridHeight) {
        // Preserve the existing background color
        const bg = this.readBufferBg(buffer, x, y)
        buffer.setCell(x, y, char, borderColor, bg, 0)
      }
    }

    drawBorderCell(x1, y1, "┌")
    drawBorderCell(x2, y1, "┐")
    drawBorderCell(x1, y2, "└")
    drawBorderCell(x2, y2, "┘")

    for (let x = x1 + 1; x < x2; x++) {
      drawBorderCell(x, y1, "─")
      drawBorderCell(x, y2, "─")
    }

    drawBorderCell(x1, box.y, "│")
    drawBorderCell(x2, box.y, "│")
  }

  private renderTextCursor(buffer: OptimizedBuffer, box: TextBox): void {
    if (!this.cursorBlinkVisible) return

    const cursorX = box.x + this.textCursorPos
    if (cursorX >= 0 && cursorX < this.gridWidth && box.y >= 0 && box.y < this.gridHeight) {
      const charInfo = this.textCursorPos < box.chars.length ? box.chars[this.textCursorPos]! : null
      const char = charInfo ? charInfo.char : " "
      const isBold = charInfo ? charInfo.bold : this.boldMode
      const fg = this.textColor
      const attrs = isBold ? TextAttributes.BOLD : 0
      buffer.setCell(cursorX, box.y, char, fg, this.cursorBgColor, attrs)
    }
  }

  private renderRectangle(buffer: OptimizedBuffer, rect: Rectangle, isHovered: boolean, _isSelected: boolean): void {
    const { x1, y1, x2, y2 } = this.normalizeRect(rect)
    const attrs = rect.bold ? TextAttributes.BOLD : 0
    const hasStroke = rect.strokeColor !== null

    // Render fill area (interior of rectangle, or full area if no stroke)
    if (rect.fillColor) {
      // If no stroke, fill the entire area; otherwise fill only interior
      const fillX1 = hasStroke ? x1 + 1 : x1
      const fillY1 = hasStroke ? y1 + 1 : y1
      const fillX2 = hasStroke ? x2 - 1 : x2
      const fillY2 = hasStroke ? y2 - 1 : y2
      
      for (let y = fillY1; y <= fillY2; y++) {
        for (let x = fillX1; x <= fillX2; x++) {
          if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue
          buffer.setCell(x, y, " ", this.textColor, rect.fillColor, 0)
        }
      }
    }

    // Render border only if stroke color is not transparent
    if (hasStroke) {
      const strokeColor = rect.strokeColor!
      
      for (let y = y1; y <= y2; y++) {
        for (let x = x1; x <= x2; x++) {
          if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

          let char = ""
          if (y === y1 && x === x1) char = "┌"
          else if (y === y1 && x === x2) char = "┐"
          else if (y === y2 && x === x1) char = "└"
          else if (y === y2 && x === x2) char = "┘"
          else if (y === y1 || y === y2) char = "─"
          else if (x === x1 || x === x2) char = "│"

          if (char) {
            let bg = this.bgColor
            if (isHovered) {
              bg = this.hoverColor
            }
            buffer.setCell(x, y, char, strokeColor, bg, attrs)
          }
        }
      }
    }
  }

  private renderRectanglePreview(buffer: OptimizedBuffer): void {
    const x1 = Math.min(this.drawStartX, this.drawCursorX)
    const x2 = Math.max(this.drawStartX, this.drawCursorX)
    const y1 = Math.min(this.drawStartY, this.drawCursorY)
    const y2 = Math.max(this.drawStartY, this.drawCursorY)

    const fg = this.currentStrokeColor ?? this.textColor
    const attrs = this.boldMode ? TextAttributes.BOLD : 0

    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

        let char = ""
        if (y === y1 && x === x1) char = "┌"
        else if (y === y1 && x === x2) char = "┐"
        else if (y === y2 && x === x1) char = "└"
        else if (y === y2 && x === x2) char = "┘"
        else if (y === y1 || y === y2) char = "─"
        else if (x === x1 || x === x2) char = "│"

        if (char) {
          buffer.setCell(x, y, char, fg, this.bgColor, attrs)
        }
      }
    }
  }

  private renderLine(buffer: OptimizedBuffer, line: Line, isHovered: boolean, _isSelected: boolean): void {
    // Use strokeColor for the line, fall back to text color
    // Selection highlighting is done separately via renderLineSelectionHighlight
    const strokeColor = line.strokeColor ?? this.textColor
    const attrs = line.bold ? TextAttributes.BOLD : 0

    const points = this.getLinePoints(line.x1, line.y1, line.x2, line.y2)
    
    for (let i = 0; i < points.length; i++) {
      const { x, y } = points[i]!
      if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

      // Lines always preserve the existing background color
      let bg = this.readBufferBg(buffer, x, y)
      if (isHovered) {
        bg = this.hoverColor
      }

      const char = this.getLineChar(line.x1, line.y1, line.x2, line.y2, i, points.length)
      buffer.setCell(x, y, char, strokeColor, bg, attrs)
    }
  }

  private renderLinePreview(buffer: OptimizedBuffer): void {
    const fg = this.currentStrokeColor ?? this.textColor
    const attrs = this.boldMode ? TextAttributes.BOLD : 0

    const points = this.getLinePoints(this.drawStartX, this.drawStartY, this.drawCursorX, this.drawCursorY)
    
    for (let i = 0; i < points.length; i++) {
      const { x, y } = points[i]!
      if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

      // Line preview preserves existing background
      const bg = this.readBufferBg(buffer, x, y)
      const char = this.getLineChar(this.drawStartX, this.drawStartY, this.drawCursorX, this.drawCursorY, i, points.length)
      buffer.setCell(x, y, char, fg, bg, attrs)
    }
  }

  private renderSelectionBoxPreview(buffer: OptimizedBuffer): void {
    const x1 = Math.min(this.drawStartX, this.drawCursorX)
    const x2 = Math.max(this.drawStartX, this.drawCursorX)
    const y1 = Math.min(this.drawStartY, this.drawCursorY)
    const y2 = Math.max(this.drawStartY, this.drawCursorY)

    const fg = this.toolbarActiveColor 

    // 绘制边框
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

        let char = ""
        if (y === y1 && x === x1) char = "+"
        else if (y === y1 && x === x2) char = "+"
        else if (y === y2 && x === x1) char = "+"
        else if (y === y2 && x === x2) char = "+"
        else if (y === y1 || y === y2) char = "-"
        else if (x === x1 || x === x2) char = "│"

        if (char) {
          const currentBg = this.readBufferBg(buffer, x, y)
          buffer.setCell(x, y, char, fg, currentBg, 0)
        }
      }
    }
  }

  private getLineChar(x1: number, y1: number, x2: number, y2: number, index: number, total: number): string {
    const dx = x2 - x1
    const dy = y2 - y1

    // Determine line direction and character
    if (dx === 0) {
      // Vertical line
      if (index === 0) return dy > 0 ? "╷" : "╵"
      if (index === total - 1) return dy > 0 ? "╵" : "╷"
      return "│"
    } else if (dy === 0) {
      // Horizontal line
      if (index === 0) return dx > 0 ? "╶" : "╴"
      if (index === total - 1) return dx > 0 ? "╴" : "╶"
      return "─"
    } else {
      // Diagonal line
      const goingRight = dx > 0
      const goingDown = dy > 0
      
      if (goingRight === goingDown) {
        // Going down-right or up-left: use backslash-like
        return "╲"
      } else {
        // Going down-left or up-right: use forward slash-like
        return "╱"
      }
    }
  }

  // Read the current character at a buffer position
  private readBufferChar(buffer: OptimizedBuffer, x: number, y: number): string {
    const buffers = buffer.buffers
    const index = y * buffer.width + x
    const charCode = buffers.char[index]
    if (!charCode || charCode === 0) return " "
    return String.fromCodePoint(charCode)
  }

  // Read the current foreground color at a buffer position
  private readBufferFg(buffer: OptimizedBuffer, x: number, y: number): RGBA {
    const buffers = buffer.buffers
    const index = (y * buffer.width + x) * 4
    return RGBA.fromValues(
      buffers.fg[index]!,
      buffers.fg[index + 1]!,
      buffers.fg[index + 2]!,
      buffers.fg[index + 3]!
    )
  }

  // Read the current background color at a buffer position
  private readBufferBg(buffer: OptimizedBuffer, x: number, y: number): RGBA {
    const buffers = buffer.buffers
    const index = (y * buffer.width + x) * 4
    return RGBA.fromValues(
      buffers.bg[index]!,
      buffers.bg[index + 1]!,
      buffers.bg[index + 2]!,
      buffers.bg[index + 3]!
    )
  }

  // Read the current attributes at a buffer position
  private readBufferAttrs(buffer: OptimizedBuffer, x: number, y: number): number {
    const buffers = buffer.buffers
    const index = y * buffer.width + x
    return buffers.attributes[index] ?? 0
  }

  // Render selection highlight by reading current buffer content and changing background
  private getSelectionBg(_x: number, _y: number): RGBA {
    // Subtle muted blue for selection highlight
    return this.selectedBgColor
  }

  private renderSelectionHighlight(buffer: OptimizedBuffer, startX: number, startY: number, width: number, height: number): void {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const x = startX + dx
        const y = startY + dy
        if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue
        
        const char = this.readBufferChar(buffer, x, y)
        const fg = this.readBufferFg(buffer, x, y)
        const attrs = this.readBufferAttrs(buffer, x, y)
        const bg = this.getSelectionBg(x, y)
        buffer.setCell(x, y, char, fg, bg, attrs)
      }
    }
  }

  private renderRectangleSelectionHighlight(buffer: OptimizedBuffer, rect: Rectangle, showHandles: boolean = true): void {
    const { x1, y1, x2, y2 } = this.normalizeRect(rect)
    const midX = Math.floor((x1 + x2) / 2)
    const midY = Math.floor((y1 + y2) / 2)

    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

        // Only highlight cells that are part of the rectangle border
        const isOnBorder = (y === y1 || y === y2 || x === x1 || x === x2)
        if (!isOnBorder) continue

        let bg = this.getSelectionBg(x, y)
        if (showHandles) {
          const isCorner = (x === x1 && y === y1) || (x === x2 && y === y1) ||
                           (x === x1 && y === y2) || (x === x2 && y === y2)
          const isEdgeHandle = (x === midX && y === y1) || (x === midX && y === y2) ||
                               (x === x1 && y === midY) || (x === x2 && y === midY)
          if (isCorner || isEdgeHandle) {
            bg = this.handleColor
          }
        }

        const char = this.readBufferChar(buffer, x, y)
        const fg = this.readBufferFg(buffer, x, y)
        const attrs = this.readBufferAttrs(buffer, x, y)
        buffer.setCell(x, y, char, fg, bg, attrs)
      }
    }
  }

  private renderLineSelectionHighlight(buffer: OptimizedBuffer, line: Line): void {
    const points = this.getLinePoints(line.x1, line.y1, line.x2, line.y2)
    
    for (const { x, y } of points) {
      if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

      const char = this.readBufferChar(buffer, x, y)
      const fg = this.readBufferFg(buffer, x, y)
      const attrs = this.readBufferAttrs(buffer, x, y)
      const bg = this.getSelectionBg(x, y)
      buffer.setCell(x, y, char, fg, bg, attrs)
    }
  }

  private applyStrokeColorToSelection(): void {
    if (!this.hasSelection()) return
    
    this.saveSnapshot()
    
    for (const id of this.selectedTextBoxIds) {
      const box = this.textBoxes.find(b => b.id === id)
      if (box) {
        box.strokeColor = this.currentStrokeColor
        // Also update all characters in the text box
        for (const char of box.chars) {
          char.color = this.currentStrokeColor
        }
      }
    }
    for (const id of this.selectedRectIds) {
      const rect = this.rectangles.find(r => r.id === id)
      if (rect) {
        rect.strokeColor = this.currentStrokeColor
      }
    }
    for (const id of this.selectedLineIds) {
      const line = this.lines.find(l => l.id === id)
      if (line) {
        line.strokeColor = this.currentStrokeColor
      }
    }
  }

  private applyFillColorToSelection(): void {
    if (!this.hasSelection()) return
    
    this.saveSnapshot()
    
    for (const id of this.selectedTextBoxIds) {
      const box = this.textBoxes.find(b => b.id === id)
      if (box) {
        box.fillColor = this.currentFillColor
      }
    }
    for (const id of this.selectedRectIds) {
      const rect = this.rectangles.find(r => r.id === id)
      if (rect) {
        rect.fillColor = this.currentFillColor
      }
    }
    // Lines don't use fill color
  }

  // Returns true if click was handled
  private handleColorPickerClick(x: number, y: number): boolean {
    // Color picker is at bottom right, last row of canvas (just above toolbar)
    const pickerY = this.gridHeight - 1
    const width = this.gridWidth
    const pickerWidth = 32
    const startX = width - pickerWidth
    
    if (y !== pickerY || x < startX) {
      return false
    }
    
    // Calculate positions:
    // "Stroke: " starts at startX (8 chars)
    // Stroke colors: startX + 8 to startX + 8 + 5 (6 colors, indices 0-5)
    // "  " (2 chars)
    // "Fill: " (6 chars)
    // Fill colors: startX + 8 + 6 + 2 + 6 = startX + 22 to startX + 22 + 5
    
    const strokeColorsStart = startX + 8
    const strokeColorsEnd = strokeColorsStart + STROKE_PALETTE.length - 1
    const fillColorsStart = startX + 8 + STROKE_PALETTE.length + 2 + 6
    const fillColorsEnd = fillColorsStart + FILL_PALETTE.length - 1
    
    if (x >= strokeColorsStart && x <= strokeColorsEnd) {
      const colorIndex = x - strokeColorsStart
      if (colorIndex >= 0 && colorIndex < STROKE_PALETTE.length) {
        this.currentStrokeColorIndex = colorIndex
        this.currentStrokeColor = STROKE_PALETTE[colorIndex] ?? null
        
        // Update selected entity's stroke color
        this.applyStrokeColorToSelection()
        
        this.renderer.requestRender()
        return true
      }
    }
    
    if (x >= fillColorsStart && x <= fillColorsEnd) {
      const colorIndex = x - fillColorsStart
      if (colorIndex >= 0 && colorIndex < FILL_PALETTE.length) {
        this.currentFillColorIndex = colorIndex
        this.currentFillColor = FILL_PALETTE[colorIndex] ?? null
        
        // Update selected entity's fill color
        this.applyFillColorToSelection()
        
        this.renderer.requestRender()
        return true
      }
    }
    
    return false
  }

  private renderColorPicker(buffer: OptimizedBuffer): void {
    // Color picker in bottom right, just above toolbar (last row of canvas)
    // Layout: "Stroke: ■■■■■■  Fill: ■■■■■■"
    
    const pickerY = this.gridHeight - 1  // Last row of canvas, right above toolbar
    const width = buffer.width
    
    // Calculate starting X position (right-aligned)
    // "Stroke: " (8) + 7 colors (7) + "  " (2) + "Fill: " (6) + 7 colors (7) + padding (2) = 32
    const pickerWidth = 32
    const startX = width - pickerWidth
    
    if (startX < 0 || pickerY < 0) return
    
    // Draw background for the color picker area
    for (let x = startX; x < width; x++) {
      buffer.setCell(x, pickerY, " ", this.toolbarTextColor, this.toolbarBgColor, 0)
    }
    
    let x = startX
    
    const drawText = (text: string, fg: RGBA) => {
      for (const char of text) {
        if (x < width) {
          buffer.setCell(x, pickerY, char, fg, this.toolbarBgColor, 0)
          x++
        }
      }
    }
    
    const drawStrokeSwatch = (colorIndex: number, isSelected: boolean) => {
      const color = STROKE_PALETTE[colorIndex] ?? null
      if (x < width) {
        if (color === null) {
          const fg = isSelected ? this.toolbarActiveColor : this.toolbarTextColor
          buffer.setCell(x, pickerY, "∅", fg, this.toolbarBgColor, 0)
        } else {
          const char = isSelected ? "█" : "■"
          buffer.setCell(x, pickerY, char, color, this.toolbarBgColor, 0)
        }
        x++
      }
    }
    
    const drawFillSwatch = (colorIndex: number, isSelected: boolean) => {
      const color = FILL_PALETTE[colorIndex] ?? null
      if (x < width) {
        if (color === null) {
          const fg = isSelected ? this.toolbarActiveColor : this.toolbarTextColor
          buffer.setCell(x, pickerY, "∅", fg, this.toolbarBgColor, 0)
        } else {
          const char = isSelected ? "█" : "■"
          buffer.setCell(x, pickerY, char, color, this.toolbarBgColor, 0)
        }
        x++
      }
    }
    
    // Draw stroke section
    drawText("Stroke: ", this.toolbarTextColor)
    for (let i = 0; i < STROKE_PALETTE.length; i++) {
      drawStrokeSwatch(i, i === this.currentStrokeColorIndex)
    }
    
    drawText("  ", this.toolbarTextColor)
    
    // Draw fill section
    drawText("Fill: ", this.toolbarTextColor)
    for (let i = 0; i < FILL_PALETTE.length; i++) {
      drawFillSwatch(i, i === this.currentFillColorIndex)
    }
  }

  private renderToolbar(buffer: OptimizedBuffer): void {
    const toolbarY = buffer.height - 1
    const width = buffer.width

    for (let x = 0; x < width; x++) {
      buffer.setCell(x, toolbarY, " ", this.toolbarTextColor, this.toolbarBgColor)
    }

    let x = 0
    const drawText = (text: string, fg: RGBA) => {
      for (const char of text) {
        if (x < width) {
          buffer.setCell(x, toolbarY, char, fg, this.toolbarBgColor)
          x++
        }
      }
    }

    drawText(" Tools: ", this.toolbarTextColor)

    for (const [toolKey, toolInfo] of Object.entries(TOOLS)) {
      const isActive = this.currentTool === toolKey
      const fg = isActive ? this.toolbarActiveColor : this.toolbarTextColor
      drawText(`[${toolInfo.key}] ${toolInfo.name}  `, fg)
    }

    let modeText = ""
    if (this.activeTextBoxId !== null) {
      modeText = "| Editing (Esc to finish)"
    } else if (this.currentTool === "move") {
      modeText = "| Click to select, drag to move, drag empty space to box-select"
    } else if (this.currentTool === "text") {
      modeText = "| Click to add/edit text"
    } else if (this.isDrawingRect || this.isDrawingLine) {
      modeText = "| Drawing..."
    } else if (this.currentTool === "rectangle" || this.currentTool === "line") {
      modeText = "| Click+drag to draw"
    }
    
    if (this.boldMode) {
      modeText += " [Bold]"
    }

    drawText(modeText, this.toolbarTextColor)

    // Show save status message if active
    if (this.saveStatusMessage && Date.now() < this.saveStatusTimeout) {
      const statusText = ` | ${this.saveStatusMessage} `
      const statusStartX = width - statusText.length
      if (statusStartX > x) {
        x = statusStartX
        drawText(statusText, this.toolbarActiveColor)
      }
    } else {
      this.saveStatusMessage = null
      
      // Show undo/redo status
      const undoCount = this.historyStack.length
      const redoCount = this.redoStack.length
      const historyText = ` | ^Z Undo:${undoCount} ^U Redo:${redoCount} `
      const historyStartX = width - historyText.length
      if (historyStartX > x) {
        x = historyStartX
        const historyColor = (undoCount > 0 || redoCount > 0) 
          ? this.toolbarActiveColor 
          : this.toolbarTextColor
        drawText(historyText, historyColor)
      }
    }
  }

  // ==================== Input Handling ====================

  private setupInput(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // Handle save prompt input first
      if (this.handleSavePromptKey(key)) {
        return
      }

      // When editing text, only handle text input and escape
      // Let Ctrl+C pass through for exit handling
      if (this.activeTextBoxId !== null) {
        if (key.name === "c" && key.ctrl) {
          return  // Let the renderer's exitOnCtrlC handler process this
        }
        if (key.name === "escape") {
          this.commitActiveTextBox()
          this.setTool("move")
          return
        }
        this.handleTextInput(key)
        return
      }

      // Tool switching (only when not editing text or drawing)
      if (!this.isDrawingRect && !this.isDrawingLine && !this.isDraggingMouse) {
        if (key.sequence === "m" || key.sequence === "M") {
          this.setTool("move")
          return
        }
        if (key.sequence === "t" || key.sequence === "T") {
          this.setTool("text")
          return
        }
        if (key.sequence === "r" || key.sequence === "R") {
          this.setTool("rectangle")
          return
        }
        if (key.sequence === "l" || key.sequence === "L") {
          this.setTool("line")
          return
        }
      }

      // Save file
      if (key.name === "s" && key.ctrl && !key.meta) {
        this.saveFile()
        return
      }

      // Undo/Redo
      if (key.name === "z" && key.ctrl && !key.meta) {
        this.undo()
        return
      }
      if (key.name === "u" && key.ctrl && !key.meta) {
        this.redo()
        return
      }

      // Layer ordering (Ctrl+[ to move down, Ctrl+] to move up)
      // Note: Ctrl+[ sends \x1b (escape), Ctrl+] sends \x1d (group separator)
      // We check for both the name and the raw sequence
      if ((key.name === "[" && key.ctrl) || (key.sequence === "\x1b" && !key.name)) {
        this.moveLayerDown()
        return
      }
      if ((key.name === "]" && key.ctrl) || key.sequence === "\x1d") {
        this.moveLayerUp()
        return
      }

      // Escape (for drawing modes)
      if (key.name === "escape") {
        if (this.isDrawingRect) {
          this.isDrawingRect = false
          this.renderer.requestRender()
        } else if (this.isDrawingLine) {
          this.isDrawingLine = false
          this.renderer.requestRender()
        }
        return
      }

      // Delete selected or hovered items
      if (key.name === "delete" || key.name === "backspace") {
        // First check if there are selected items
        if (this.hasSelection()) {
          this.saveSnapshot()
          // Delete all selected items
          for (const id of this.selectedTextBoxIds) {
            this.textBoxes = this.textBoxes.filter(b => b.id !== id)
          }
          for (const id of this.selectedRectIds) {
            this.rectangles = this.rectangles.filter(r => r.id !== id)
          }
          for (const id of this.selectedLineIds) {
            this.lines = this.lines.filter(l => l.id !== id)
          }
          this.clearSelection()
          this.renderer.requestRender()
          return
        }
        // Then check hovered items
        if (this.hoveredTextBoxId !== null) {
          this.deleteTextBox(this.hoveredTextBoxId)
          return
        }
        if (this.hoveredRectId !== null) {
          this.deleteRect(this.hoveredRectId)
          return
        }
        if (this.hoveredLineId !== null) {
          this.deleteLine(this.hoveredLineId)
          return
        }
      }
    })
  }

  private handleTextInput(key: KeyEvent): void {
    // Bold toggle
    if (key.name === "b" && key.ctrl && !key.meta) {
      this.toggleBold()
      return
    }

    const box = this.textBoxes.find(b => b.id === this.activeTextBoxId)
    if (!box) return

    this.resetCursorBlink()

    switch (key.name) {
      case "left":
        if (this.textCursorPos > 0) {
          this.textCursorPos--
          this.renderer.requestRender()
        }
        return
      case "right":
        if (this.textCursorPos < box.chars.length) {
          this.textCursorPos++
          this.renderer.requestRender()
        }
        return
      case "home":
        this.textCursorPos = 0
        this.renderer.requestRender()
        return
      case "end":
        this.textCursorPos = box.chars.length
        this.renderer.requestRender()
        return
      case "backspace":
        if (this.textCursorPos > 0) {
          this.saveSnapshot()
          box.chars.splice(this.textCursorPos - 1, 1)
          this.textCursorPos--
          this.renderer.requestRender()
        }
        return
      case "delete":
        if (this.textCursorPos < box.chars.length) {
          this.saveSnapshot()
          box.chars.splice(this.textCursorPos, 1)
          this.renderer.requestRender()
        }
        return
    }

    // Type character
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      const code = key.sequence.charCodeAt(0)
      if (code >= 32 && code <= 126) {
        this.saveSnapshot()
        const newChar: TextChar = { char: key.sequence, bold: this.boldMode, color: this.currentStrokeColor }
        box.chars.splice(this.textCursorPos, 0, newChar)
        this.textCursorPos++
        this.renderer.requestRender()
      }
    }
  }
}

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
    useConsole: false,
    enableMouseMovement: true,
  })

  renderer.setBackgroundColor(RGBA.fromInts(0, 0, 0, 255))

  const app = new CanvasApp(renderer)

  // Check for filename argument
  const args = process.argv.slice(2)
  if (args.length > 0) {
    const filePath = args[0]!
    app.loadFile(filePath)
  }

  renderer.start()
}

main()
