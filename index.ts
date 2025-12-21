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

interface TextChar {
  char: string
  bold: boolean
}

interface TextBox {
  id: number
  x: number
  y: number
  chars: TextChar[]
  zIndex: number
}

interface Rectangle {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
}

interface Line {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  bold: boolean
  zIndex: number
}

type Tool = "move" | "text" | "rectangle" | "line"

interface ToolInfo {
  name: string
  key: string
}

const TOOLS: Record<Tool, ToolInfo> = {
  move: { name: "Move", key: "M" },
  text: { name: "Text", key: "T" },
  rectangle: { name: "Rectangle", key: "R" },
  line: { name: "Line", key: "L" },
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

class CanvasApp {
  private renderer: CliRenderer
  private boldMode = false
  private canvas: BoxRenderable

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
  private selectedTextBoxId: number | null = null
  private selectedRectId: number | null = null
  private selectedLineId: number | null = null

  // Dragging state (for moving objects)
  private draggingTextBoxId: number | null = null
  private draggingRectId: number | null = null
  private draggingLineId: number | null = null
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

  private readonly textColor = RGBA.fromInts(255, 255, 255, 255)
  private readonly boldColor = RGBA.fromInts(255, 255, 100, 255)
  private readonly bgColor = RGBA.fromInts(0, 0, 0, 255)
  private readonly cursorBgColor = RGBA.fromInts(80, 80, 80, 255)
  private readonly toolbarBgColor = RGBA.fromInts(30, 30, 30, 255)
  private readonly toolbarTextColor = RGBA.fromInts(200, 200, 200, 255)
  private readonly toolbarActiveColor = RGBA.fromInts(100, 150, 255, 255)
  private readonly rectPreviewColor = RGBA.fromInts(100, 100, 255, 255)
  private readonly hoverColor = RGBA.fromInts(60, 60, 80, 255)
  private readonly selectedColor = RGBA.fromInts(255, 180, 80, 255)
  private readonly handleColor = RGBA.fromInts(255, 100, 100, 255)
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
    this.selectedTextBoxId = null
    this.selectedRectId = null
    this.selectedLineId = null

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
    this.selectedTextBoxId = null
    this.selectedRectId = null
    this.selectedLineId = null

    this.renderer.requestRender()
  }

  // ==================== Mouse Handling ====================

  private handleMouse(event: MouseEvent): void {
    if (event.y >= this.gridHeight) {
      return
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
      
      if (this.draggingTextBoxId !== null) {
        this.moveTextBox(this.draggingTextBoxId, event.x - this.moveOffsetX, event.y - this.moveOffsetY)
      } else if (this.draggingRectId !== null) {
        if (this.isResizingRect) {
          this.resizeRect(this.draggingRectId, event.x, event.y)
        } else {
          this.moveRect(this.draggingRectId, event.x - this.moveOffsetX, event.y - this.moveOffsetY)
        }
      } else if (this.draggingLineId !== null) {
        this.moveLine(this.draggingLineId, event.x - this.moveOffsetX, event.y - this.moveOffsetY)
      } else if (this.isDrawingRect || this.isDrawingLine) {
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
      
      // If we clicked on a selected text box and didn't drag, enter edit mode
      if (this.clickedOnSelectedTextBox && !this.hasDragged && this.selectedTextBoxId !== null) {
        const textBox = this.textBoxes.find(b => b.id === this.selectedTextBoxId)
        if (textBox) {
          this.activeTextBoxId = textBox.id
          const relativeX = event.x - textBox.x
          this.textCursorPos = Math.min(relativeX, this.getTextLength(textBox))
          this.selectedTextBoxId = null
          this.resetCursorBlink()
          this.renderer.requestRender()
        }
      }
      
      this.draggingTextBoxId = null
      this.draggingRectId = null
      this.draggingLineId = null
      this.isResizingRect = false
      this.resizeHandle = null
      this.isDraggingMouse = false
      this.clickedOnSelectedTextBox = false
      this.hasDragged = false
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
        
        // First check if clicking on a hovered rectangle's resize handle
        if (this.hoveredRectId !== null) {
          const handle = this.getResizeHandleAt(this.hoveredRectId, event.x, event.y)
          if (handle) {
            this.saveSnapshot()
            this.draggingRectId = this.hoveredRectId
            this.isResizingRect = true
            this.resizeHandle = handle
            this.isDraggingMouse = true
            return
          }
        }

        // Check if clicking on a text box
        const clickedTextBox = this.getTextBoxAt(event.x, event.y)
        if (clickedTextBox) {
          // If already selected, prepare for potential edit mode (on mouse up if no drag)
          if (this.selectedTextBoxId === clickedTextBox.id) {
            this.clickedOnSelectedTextBox = true
            // Still prepare for dragging
            this.draggingTextBoxId = clickedTextBox.id
            this.moveOffsetX = event.x - clickedTextBox.x
            this.moveOffsetY = event.y - clickedTextBox.y
            this.isDraggingMouse = true
            this.saveSnapshot()
            this.renderer.requestRender()
            return
          }
          
          // Select this text box
          this.selectedTextBoxId = clickedTextBox.id
          this.selectedRectId = null
          this.selectedLineId = null
          
          // Prepare for dragging
          this.draggingTextBoxId = clickedTextBox.id
          this.moveOffsetX = event.x - clickedTextBox.x
          this.moveOffsetY = event.y - clickedTextBox.y
          this.isDraggingMouse = true
          this.saveSnapshot()
          this.renderer.requestRender()
          return
        }

        // Check if clicking on a rectangle
        const clickedRect = this.getRectangleAt(event.x, event.y)
        if (clickedRect) {
          this.saveSnapshot()
          // Select this rectangle
          this.selectedTextBoxId = null
          this.selectedRectId = clickedRect.id
          this.selectedLineId = null
          const normalized = this.normalizeRect(clickedRect)
          this.draggingRectId = clickedRect.id
          this.moveOffsetX = event.x - normalized.x1
          this.moveOffsetY = event.y - normalized.y1
          this.isDraggingMouse = true
          this.renderer.requestRender()
          return
        }

        // Check if clicking on a line
        const clickedLine = this.getLineAt(event.x, event.y)
        if (clickedLine) {
          this.saveSnapshot()
          // Select this line
          this.selectedTextBoxId = null
          this.selectedRectId = null
          this.selectedLineId = clickedLine.id
          const normalized = this.normalizeLine(clickedLine)
          this.draggingLineId = clickedLine.id
          this.moveOffsetX = event.x - normalized.x1
          this.moveOffsetY = event.y - normalized.y1
          this.isDraggingMouse = true
          this.renderer.requestRender()
          return
        }

        // Clicking on empty space - clear selection
        this.selectedTextBoxId = null
        this.selectedRectId = null
        this.selectedLineId = null
        this.renderer.requestRender()
        return
      }

      // Drawing tools: create new objects (ignore existing objects)
      // Clear selection when using drawing tools
      this.selectedRectId = null
      this.selectedLineId = null

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
      }
      this.rectangles.push(rect)
      // Select the newly created rectangle
      this.selectedRectId = rect.id
      this.selectedLineId = null
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
      }
      this.lines.push(line)
      // Select the newly created line
      this.selectedLineId = line.id
      this.selectedRectId = null
    }

    this.isDrawingLine = false
    // Switch back to Move tool after drawing
    this.setTool("move")
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

  private getSelectedObject(): { type: "text" | "rect" | "line"; zIndex: number } | null {
    if (this.selectedTextBoxId !== null) {
      const box = this.textBoxes.find(b => b.id === this.selectedTextBoxId)
      if (box) return { type: "text", zIndex: box.zIndex }
    }
    if (this.selectedRectId !== null) {
      const rect = this.rectangles.find(r => r.id === this.selectedRectId)
      if (rect) return { type: "rect", zIndex: rect.zIndex }
    }
    if (this.selectedLineId !== null) {
      const line = this.lines.find(l => l.id === this.selectedLineId)
      if (line) return { type: "line", zIndex: line.zIndex }
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
    if (this.selectedTextBoxId !== null) {
      const box = this.textBoxes.find(b => b.id === this.selectedTextBoxId)
      if (box) box.zIndex = lowerZ
    } else if (this.selectedRectId !== null) {
      const rect = this.rectangles.find(r => r.id === this.selectedRectId)
      if (rect) rect.zIndex = lowerZ
    } else if (this.selectedLineId !== null) {
      const line = this.lines.find(l => l.id === this.selectedLineId)
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
    if (this.selectedTextBoxId !== null) {
      const box = this.textBoxes.find(b => b.id === this.selectedTextBoxId)
      if (box) box.zIndex = higherZ
    } else if (this.selectedRectId !== null) {
      const rect = this.rectangles.find(r => r.id === this.selectedRectId)
      if (rect) rect.zIndex = higherZ
    } else if (this.selectedLineId !== null) {
      const line = this.lines.find(l => l.id === this.selectedLineId)
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
    this.isDraggingMouse = false
    this.currentTool = tool
    
    // Clear hover and selection state when switching away from move tool
    if (tool !== "move") {
      this.hoveredTextBoxId = null
      this.hoveredRectId = null
      this.hoveredLineId = null
      this.selectedTextBoxId = null
      this.selectedRectId = null
      this.selectedLineId = null
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
        const isHovered = item.obj.id === this.hoveredTextBoxId && item.obj.id !== this.activeTextBoxId && item.obj.id !== this.selectedTextBoxId
        const isSelected = item.obj.id === this.selectedTextBoxId
        this.renderTextBox(buffer, item.obj, isHovered, isSelected)
      } else if (item.type === "rect") {
        const isHovered = item.obj.id === this.hoveredRectId && item.obj.id !== this.selectedRectId
        this.renderRectangle(buffer, item.obj, isHovered, false)
      } else if (item.type === "line") {
        const isHovered = item.obj.id === this.hoveredLineId && item.obj.id !== this.selectedLineId
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

    // Draw active text box border and cursor - on top of everything
    if (this.activeTextBoxId !== null) {
      const activeBox = this.textBoxes.find(b => b.id === this.activeTextBoxId)
      if (activeBox) {
        this.renderTextBoxBorder(buffer, activeBox, this.textBoxBorderColor)
        this.renderTextCursor(buffer, activeBox)
      }
    }

    // Draw selection highlights ON TOP of everything
    if (this.selectedTextBoxId !== null) {
      const selectedTextBox = this.textBoxes.find(b => b.id === this.selectedTextBoxId)
      if (selectedTextBox) {
        this.renderTextBox(buffer, selectedTextBox, false, true)
      }
    }
    if (this.selectedRectId !== null) {
      const selectedRect = this.rectangles.find(r => r.id === this.selectedRectId)
      if (selectedRect) {
        this.renderRectangle(buffer, selectedRect, false, true)
      }
    }
    if (this.selectedLineId !== null) {
      const selectedLine = this.lines.find(l => l.id === this.selectedLineId)
      if (selectedLine) {
        this.renderLine(buffer, selectedLine, false, true)
      }
    }

    // Draw toolbar
    this.renderToolbar(buffer)
  }

  private renderTextBox(buffer: OptimizedBuffer, box: TextBox, isHovered: boolean, isSelected: boolean = false): void {
    let bg = this.bgColor
    if (isSelected) {
      bg = this.selectedColor
    } else if (isHovered) {
      bg = this.hoverColor
    }
    const boxWidth = Math.max(1, box.chars.length)

    for (let i = 0; i < boxWidth; i++) {
      const x = box.x + i
      if (x >= 0 && x < this.gridWidth && box.y >= 0 && box.y < this.gridHeight) {
        if (i < box.chars.length) {
          const charInfo = box.chars[i]!
          const fg = charInfo.bold ? this.boldColor : this.textColor
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
        buffer.setCell(x, y, char, borderColor, this.bgColor, 0)
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
      const fg = isBold ? this.boldColor : this.textColor
      const attrs = isBold ? TextAttributes.BOLD : 0
      buffer.setCell(cursorX, box.y, char, fg, this.cursorBgColor, attrs)
    }
  }

  private renderRectangle(buffer: OptimizedBuffer, rect: Rectangle, isHovered: boolean, isSelected: boolean): void {
    const { x1, y1, x2, y2 } = this.normalizeRect(rect)
    const fg = rect.bold ? this.boldColor : this.textColor
    const attrs = rect.bold ? TextAttributes.BOLD : 0

    const midX = Math.floor((x1 + x2) / 2)
    const midY = Math.floor((y1 + y2) / 2)

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
          if (isSelected) {
            const isCorner = (x === x1 && y === y1) || (x === x2 && y === y1) ||
                             (x === x1 && y === y2) || (x === x2 && y === y2)
            const isEdgeHandle = (x === midX && y === y1) || (x === midX && y === y2) ||
                                 (x === x1 && y === midY) || (x === x2 && y === midY)
            bg = (isCorner || isEdgeHandle) ? this.handleColor : this.selectedColor
          } else if (isHovered) {
            bg = this.hoverColor
          }
          buffer.setCell(x, y, char, fg, bg, attrs)
        }
      }
    }
  }

  private renderRectanglePreview(buffer: OptimizedBuffer): void {
    const x1 = Math.min(this.drawStartX, this.drawCursorX)
    const x2 = Math.max(this.drawStartX, this.drawCursorX)
    const y1 = Math.min(this.drawStartY, this.drawCursorY)
    const y2 = Math.max(this.drawStartY, this.drawCursorY)

    const fg = this.boldMode ? this.boldColor : this.textColor
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
          buffer.setCell(x, y, char, fg, this.rectPreviewColor, attrs)
        }
      }
    }
  }

  private renderLine(buffer: OptimizedBuffer, line: Line, isHovered: boolean, isSelected: boolean): void {
    const fg = line.bold ? this.boldColor : this.textColor
    let bg = this.bgColor
    if (isSelected) {
      bg = this.selectedColor
    } else if (isHovered) {
      bg = this.hoverColor
    }
    const attrs = line.bold ? TextAttributes.BOLD : 0

    const points = this.getLinePoints(line.x1, line.y1, line.x2, line.y2)
    
    for (let i = 0; i < points.length; i++) {
      const { x, y } = points[i]!
      if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

      const char = this.getLineChar(line.x1, line.y1, line.x2, line.y2, i, points.length)
      buffer.setCell(x, y, char, fg, bg, attrs)
    }
  }

  private renderLinePreview(buffer: OptimizedBuffer): void {
    const fg = this.boldMode ? this.boldColor : this.textColor
    const attrs = this.boldMode ? TextAttributes.BOLD : 0

    const points = this.getLinePoints(this.drawStartX, this.drawStartY, this.drawCursorX, this.drawCursorY)
    
    for (let i = 0; i < points.length; i++) {
      const { x, y } = points[i]!
      if (x < 0 || x >= this.gridWidth || y < 0 || y >= this.gridHeight) continue

      const char = this.getLineChar(this.drawStartX, this.drawStartY, this.drawCursorX, this.drawCursorY, i, points.length)
      buffer.setCell(x, y, char, fg, this.rectPreviewColor, attrs)
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
      modeText = "| Click to select, drag to move"
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

  // ==================== Input Handling ====================

  private setupInput(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // When editing text, only handle text input and escape
      if (this.activeTextBoxId !== null) {
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

      // Delete selected or hovered item
      if (key.name === "delete" || key.name === "backspace") {
        // First check selected items
        if (this.selectedTextBoxId !== null) {
          this.deleteTextBox(this.selectedTextBoxId)
          this.selectedTextBoxId = null
          return
        }
        if (this.selectedRectId !== null) {
          this.deleteRect(this.selectedRectId)
          this.selectedRectId = null
          return
        }
        if (this.selectedLineId !== null) {
          this.deleteLine(this.selectedLineId)
          this.selectedLineId = null
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
        const newChar: TextChar = { char: key.sequence, bold: this.boldMode }
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

  new CanvasApp(renderer)

  renderer.start()
}

main()
