/* ================================================================
   Graph / Chart Manager
   Uses plain Canvas API to draw simple Bar/Pie/Line charts
   ================================================================ */

class GraphManager {
    constructor(app) {
        this.app = app;
    }

    renderChart(el, canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const type = el.graphType || 'bar';
        const data = el.graphData || [
            { label: 'Q1', value: 40, color: '#4262ff' },
            { label: 'Q2', value: 70, color: '#2ecc71' },
            { label: 'Q3', value: 30, color: '#f39c12' },
            { label: 'Q4', value: 90, color: '#ff6b6b' }
        ];

        if (type === 'bar') this._drawBarChart(ctx, w, h, data);
        if (type === 'pie') this._drawPieChart(ctx, w, h, data);
        if (type === 'line') this._drawLineChart(ctx, w, h, data);
    }

    _drawBarChart(ctx, w, h, data) {
        const max = Math.max(...data.map(d => d.value)) || 100;
        const pad = 20;
        const aw = w - pad*2;
        const ah = h - pad*2;
        const barW = (aw / data.length) - 10;
        
        // Axes
        ctx.strokeStyle = '#e2e4e9';
        ctx.beginPath();
        ctx.moveTo(pad, pad);
        ctx.lineTo(pad, h - pad);
        ctx.lineTo(w - pad, h - pad);
        ctx.stroke();

        data.forEach((d, i) => {
            const bh = (d.value / max) * ah;
            const bx = pad + 10 + i * (barW + 10);
            const by = h - pad - bh;
            
            ctx.fillStyle = d.color || '#4262ff';
            ctx.fillRect(bx, by, barW, bh);

            ctx.fillStyle = '#1a1a2e';
            ctx.font = '10px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(d.label, bx + barW/2, h - pad + 12);
        });
    }

    _drawPieChart(ctx, w, h, data) {
        const cx = w/2;
        const cy = h/2;
        const r = Math.min(cx, cy) - 20;
        const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
        
        let startAngle = 0;
        data.forEach(d => {
            const sliceAngle = (d.value / total) * 2 * Math.PI;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
            ctx.closePath();
            ctx.fillStyle = d.color || '#4262ff';
            ctx.fill();
            
            // Labels
            const mid = startAngle + sliceAngle/2;
            const lx = cx + Math.cos(mid) * (r + 10);
            const ly = cy + Math.sin(mid) * (r + 10);
            ctx.fillStyle = '#1a1a2e';
            ctx.font = '10px Inter';
            ctx.textAlign = lx > cx ? 'left' : 'right';
            ctx.fillText(d.label, lx, ly);

            startAngle += sliceAngle;
        });
    }

    _drawLineChart(ctx, w, h, data) {
        const max = Math.max(...data.map(d => d.value)) || 100;
        const pad = 20;
        const aw = w - pad*2;
        const ah = h - pad*2;
        const step = aw / Math.max(1, data.length - 1);
        
        ctx.strokeStyle = '#e2e4e9';
        ctx.beginPath();
        ctx.moveTo(pad, pad);
        ctx.lineTo(pad, h - pad);
        ctx.lineTo(w - pad, h - pad);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = '#4262ff';
        ctx.lineWidth = 2;
        data.forEach((d, i) => {
            const px = pad + i * step;
            const py = h - pad - ((d.value / max) * ah);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
        ctx.stroke();

        data.forEach((d, i) => {
            const px = pad + i * step;
            const py = h - pad - ((d.value / max) * ah);
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, 2*Math.PI);
            ctx.fillStyle = '#4262ff';
            ctx.fill();

            ctx.fillStyle = '#1a1a2e';
            ctx.font = '10px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(d.label, px, h - pad + 12);
        });
    }

    openEditor(elId) {
        const el = this.app.state.elements.find(e => e.id === elId);
        if (!el) return;
        const raw = JSON.stringify(el.graphData || [], null, 2);
        const input = prompt("Edit JSON Data:", raw);
        if (input !== null) {
            try {
                el.graphData = JSON.parse(input);
                this.app.board.renderElement(el);
                this.app.saveState();
            } catch (e) {
                alert("Invalid JSON data format.");
            }
        }
    }
}

window.GraphManager = GraphManager;
