/* ================================================================
   Flowchart Manager - Pro level flowchart connections and logic
   ================================================================ */

class FlowchartManager {
    constructor(app) {
        this.app = app;
        this.connections = []; // Array of { id, from: nodeId, fromPort: 'top'|'right'|'bottom'|'left', to: nodeId, toPort }
        
        // Setup dragging from ports
        this.isConnecting = false;
        this.startNode = null;
        this.startPort = null;
        this.tempLine = null;

        this._bindEvents();
    }

    _bindEvents() {
        const wrapper = this.app.board.wrapper;
        
        wrapper.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('fc-port')) {
                e.stopPropagation();
                this.isConnecting = true;
                this.startNode = e.target.dataset.nodeId;
                this.startPort = e.target.dataset.port;
                
                const rect = wrapper.getBoundingClientRect();
                const portRect = e.target.getBoundingClientRect();
                const startPoint = this.app.board.screenToBoard(
                    portRect.left + portRect.width / 2 - rect.left,
                    portRect.top + portRect.height / 2 - rect.top
                );

                this.tempLine = {
                    id: 'temp-conn',
                    x1: startPoint.x, y1: startPoint.y,
                    x2: startPoint.x, y2: startPoint.y,
                    arrow: true,
                    curved: false, // Orthogonal lines for flowcharts
                    color: '#4262ff'
                };
                
                // Put board in a state where drag drop won't interfere
                this.app.tools.temporarySwitch('select'); 
            }
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (this.isConnecting && this.tempLine) {
                const rect = wrapper.getBoundingClientRect();
                const bp = this.app.board.screenToBoard(e.clientX - rect.left, e.clientY - rect.top);
                this.tempLine.x2 = bp.x;
                this.tempLine.y2 = bp.y;
                this.app.board.renderConnection(this.tempLine);
            }
        });

        wrapper.addEventListener('mouseup', (e) => {
            if (this.isConnecting) {
                const targetPort = e.target.closest('.fc-port');
                if (targetPort && targetPort.dataset.nodeId !== this.startNode) {
                    // Create connection
                    this.addConnection(
                        this.startNode, 
                        this.startPort, 
                        targetPort.dataset.nodeId, 
                        targetPort.dataset.port
                    );
                }
                
                // Cleanup temp line
                const tempG = this.app.board.svgOverlay.querySelector(`[data-conn-id="temp-conn"]`);
                if (tempG) tempG.remove();
                
                this.isConnecting = false;
                this.startNode = null;
                this.startPort = null;
                this.tempLine = null;
                this.app.tools.restorePrevious();
            }
        });
    }

    addConnection(fromNode, fromPort, toNode, toPort) {
        const id = 'conn-' + Date.now();
        this.connections.push({ id, from: fromNode, fromPort, to: toNode, toPort });
        this.updateConnectionsForNode(fromNode);
        this.app.saveState();
    }

    updateConnectionsForNode(nodeId) {
        this.connections.forEach(conn => {
            if (conn.from === nodeId || conn.to === nodeId) {
                this._renderConnection(conn);
            }
        });
    }

    _renderConnection(conn) {
        const fromEl = this.app.state.elements.find(e => e.id === conn.from);
        const toEl = this.app.state.elements.find(e => e.id === conn.to);
        if (!fromEl || !toEl) return;

        const getPortCoords = (el, port) => {
            const w = el.width || 150;
            const h = el.height || 60;
            if (port === 'top') return { x: el.x + w/2, y: el.y };
            if (port === 'right') return { x: el.x + w, y: el.y + h/2 };
            if (port === 'bottom') return { x: el.x + w/2, y: el.y + h };
            if (port === 'left') return { x: el.x, y: el.y + h/2 };
            return { x: el.x + w/2, y: el.y + h/2 };
        };

        const start = getPortCoords(fromEl, conn.fromPort);
        const end = getPortCoords(toEl, conn.toPort);

        this.app.board.renderConnection({
            id: conn.id,
            from: conn.from,
            to: conn.to,
            x1: start.x, y1: start.y,
            x2: end.x, y2: end.y,
            arrow: true,
            curved: false,
            color: '#1a1a2e'
        });
    }

    renderAllConnections() {
        this.connections.forEach(c => this._renderConnection(c));
    }

    loadData(connectionsData) {
        this.connections = connectionsData || [];
        this.renderAllConnections();
    }

    getData() {
        return this.connections;
    }
}

window.FlowchartManager = FlowchartManager;
