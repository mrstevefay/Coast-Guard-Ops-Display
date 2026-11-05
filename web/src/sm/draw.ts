import type maplibregl from 'maplibre-gl';
import { TerraDraw, TerraDrawLineStringMode, TerraDrawPointMode, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Target, TargetGeometry, TargetKind } from '../../../shared/types';

export type DrawKind = 'point' | 'area' | 'line';
const MODE: Record<DrawKind, string> = { point: 'point', area: 'polygon', line: 'linestring' };

export interface DrawCallbacks {
  /** A new shape was finished; return false to keep it on the canvas. */
  onFinished: (kind: DrawKind, geometry: TargetGeometry) => Promise<void> | void;
  /** Geometry of the target being edited changed (debounced). */
  onEdited: (targetId: number, geometry: TargetGeometry) => Promise<void> | void;
  onModeChange: (mode: DrawKind | 'select' | 'static') => void;
}

/** terra-draw wrapper: draw new targets, edit an existing one's shape. */
export class TargetDrawing {
  private draw: TerraDraw;
  private kind: DrawKind | undefined;
  private editing?: { targetId: number; featureId: string };
  private editTimer?: number;

  constructor(map: maplibregl.Map, private readonly cb: DrawCallbacks) {
    this.draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, renderBelowLayerId: 'station-halo' }),
      modes: [
        new TerraDrawPointMode({ styles: { pointColor: '#facc15', pointOutlineColor: '#111111', pointOutlineWidth: 2, pointWidth: 7 } }),
        new TerraDrawPolygonMode({ styles: { fillColor: '#facc15', fillOpacity: 0.25, outlineColor: '#facc15', outlineWidth: 3, closingPointColor: '#ffffff' } }),
        new TerraDrawLineStringMode({ styles: { lineStringColor: '#facc15', lineStringWidth: 4 } }),
        new TerraDrawSelectMode({
          flags: {
            point: { feature: { draggable: true } },
            polygon: { feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true } } },
            linestring: { feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true } } },
          },
          styles: { selectedPolygonColor: '#facc15', selectedPolygonFillOpacity: 0.25, selectedPolygonOutlineColor: '#ffffff', selectedPolygonOutlineWidth: 3, selectedLineStringColor: '#ffffff', selectedLineStringWidth: 4, selectedPointColor: '#ffffff', selectionPointColor: '#ffffff', selectionPointOutlineColor: '#111111', midPointColor: '#facc15' },
        }),
      ],
    });
    this.draw.start();
    this.draw.setMode('static');
    this.draw.on('finish', (id, ctx) => {
      if (ctx.action !== 'draw' || !this.kind) return;
      const f = this.draw.getSnapshotFeature(id);
      if (!f) return;
      const geometry = f.geometry as TargetGeometry;
      const kind = this.kind;
      this.draw.removeFeatures([id]);
      this.setMode('static');
      void this.cb.onFinished(kind, geometry);
    });
    this.draw.on('change', (ids, type) => {
      if (type !== 'update' || !this.editing) return;
      if (!ids.includes(this.editing.featureId)) return;
      if (this.editTimer) clearTimeout(this.editTimer);
      this.editTimer = window.setTimeout(() => {
        const f = this.draw.getSnapshotFeature(this.editing!.featureId);
        if (f) void this.cb.onEdited(this.editing!.targetId, f.geometry as TargetGeometry);
      }, 400);
    });
  }

  setMode(kind: DrawKind | 'static'): void {
    this.stopEditing(false);
    this.kind = kind === 'static' ? undefined : kind;
    this.draw.setMode(kind === 'static' ? 'static' : MODE[kind]);
    this.cb.onModeChange(kind);
  }

  get mode(): DrawKind | 'select' | 'static' {
    if (this.editing) return 'select';
    return this.kind ?? 'static';
  }

  /** Put a target's geometry on the draw canvas in select mode for vertex editing. */
  editTarget(t: Target): void {
    this.stopEditing(false);
    this.kind = undefined;
    const mode = MODE[t.kind as TargetKind];
    const [ok] = this.draw.addFeatures([{ type: 'Feature', properties: { mode }, geometry: t.geometry as any }]);
    if (!ok?.valid || !ok.id) return;
    this.editing = { targetId: t.id, featureId: String(ok.id) };
    this.draw.setMode('select');
    this.draw.selectFeature(ok.id);
    this.cb.onModeChange('select');
  }

  stopEditing(notify = true): void {
    if (this.editTimer) clearTimeout(this.editTimer);
    if (this.editing) {
      try {
        this.draw.removeFeatures([this.editing.featureId]);
      } catch {
        /* already gone */
      }
      this.editing = undefined;
    }
    this.draw.setMode('static');
    if (notify) this.cb.onModeChange('static');
  }

  get editingTargetId(): number | undefined {
    return this.editing?.targetId;
  }

  destroy(): void {
    this.draw.stop();
  }
}
