import { useEffect, useRef, useState } from 'react';
import { Draggable, templateEventData } from './WeekGrid';
import type { PoolModel, TemplateModel } from '../api';
import { DAY, HOUR } from '../week';

/** A new template's length when none is given. */
export const DEFAULT_LENGTH = 2 * HOUR;

/** What a pool holds, in a line: the shows, or the movie filter. */
export function poolSummary(p: PoolModel | undefined): string {
  if (!p) return 'unknown pool';
  if (p.raw) return `${'shows' in p.raw ? 'shows' : 'movies'} by rules${p.order === 'shuffle' ? ' (shuffled)' : ''}`;
  if (p.shows) {
    const names = p.shows.map((s) => s.show);
    return `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}${p.order === 'shuffle' ? ' (shuffled)' : ''}`;
  }
  const m = p.movies ?? {};
  const len = m.duration ? ` ${m.duration.op} ${Math.round(m.duration.ms / 60_000)} min` : '';
  return `${m.genre ?? 'Any'} movies${len}`;
}

export const lengthText = (ms: number): string => {
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / 60_000);
  return `${h > 0 ? `${h} h` : ''}${h > 0 && m > 0 ? ' ' : ''}${m > 0 ? `${m} min` : ''}` || '0';
};

interface PaletteProps {
  templates: Record<string, TemplateModel>;
  pools: Record<string, PoolModel>;
  hueOf: (pool: string) => number;
  armed: string | undefined;
  /** How many placed slots come from each template. */
  uses: Record<string, number>;
  onArm: (name: string | undefined) => void;
  onEdit: (name: string) => void;
}

/** The slot list: a card per template, dragged onto the week or picked up with a click and then clicked onto it. */
export function Palette({ templates, pools, hueOf, armed, uses, onArm, onEdit }: PaletteProps) {
  const list = useRef<HTMLUListElement>(null);
  // The cards are dragged by the calendar library, which reads the name and length off each card.
  useEffect(() => {
    if (!list.current) return;
    const d = new Draggable(list.current, { itemSelector: '.tpl', eventData: templateEventData });
    return () => d.destroy();
  }, []);

  const names = Object.keys(templates);
  return (
    <>
      <ul className="palette" aria-label="Slot templates" ref={list}>
        {names.map((name) => {
          const t = templates[name]!;
          return (
            <li key={name}>
              <button type="button" className={`tpl ${armed === name ? 'armed' : ''}`} style={{ ['--h' as string]: hueOf(t.pool) }} aria-pressed={armed === name}
                aria-label={`${name}: ${lengthText(t.length)}, ${t.pool}: ${poolSummary(pools[t.pool])}${t.link ? `, ${t.linkMode === 'rerun' ? 'rerun of' : 'continues'} ${t.link}` : ''}`}
                title="Drag onto the week, or click and then click a spot on the week"
                data-name={name} data-length={t.length}
                onClick={() => onArm(armed === name ? undefined : name)}
                onDoubleClick={() => onEdit(name)}>
                <strong>{name}</strong>
                <small>{lengthText(t.length)} · {t.pool}</small>
                <small>{poolSummary(pools[t.pool])}</small>
                {t.link && <small>{t.linkMode === 'rerun' ? '↺' : '⇄'} {t.link}</small>}
                <small className="muted">{uses[name] ? `${uses[name]} on the week` : 'not placed'}</small>
              </button>
              <button type="button" className="tpl-edit" aria-label={`Edit template ${name}`} onClick={() => onEdit(name)}>✎</button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

interface EditorProps {
  /** The template being edited, or undefined for a new one. */
  name: string | undefined;
  template: TemplateModel | undefined;
  taken: string[];
  pools: Record<string, PoolModel>;
  grid: number;
  /** Slots placed from it that still match it (they can follow a change). */
  following: number;
  linkNames: string[];
  onSave: (name: string, t: TemplateModel, update: boolean) => void;
  onDelete: (() => void) | undefined;
  onClose: () => void;
}

/** Name, pool, length (2 hours unless set) and link of one template. */
export function TemplateEditor({ name, template, taken, pools, grid, following, linkNames, onSave, onDelete, onClose }: EditorProps) {
  const poolNames = Object.keys(pools);
  const [n, setN] = useState(name ?? '');
  const [pool, setPool] = useState(template?.pool ?? poolNames[0] ?? '');
  const [minutes, setMinutes] = useState(String((template?.length ?? DEFAULT_LENGTH) / 60_000));
  const [link, setLink] = useState(template?.link ?? '');
  const [mode, setMode] = useState<'continue' | 'rerun'>(template?.linkMode ?? 'continue');
  const [update, setUpdate] = useState(true);
  const [error, setError] = useState<string>();

  function save(): void {
    const len = (minutes.trim() === '' ? DEFAULT_LENGTH / 60_000 : Number(minutes)) * 60_000;
    if (!n.trim()) return setError('Give the template a name.');
    if (n.trim() !== name && taken.includes(n.trim())) return setError(`There is already a template called "${n.trim()}".`);
    if (!pool) return setError('Pick a pool.');
    if (!Number.isInteger(len) || len <= 0 || len % grid !== 0 || len > DAY * 7) return setError(`The length must be a whole number of minutes on the ${grid / 60_000}-minute grid.`);
    onSave(n.trim(), { pool, length: len, ...(link.trim() ? { link: link.trim(), linkMode: mode } : {}) }, update);
  }

  return (
    <div className="editor" aria-label="Template editor">
      <h2>{name ? `Template: ${name}` : 'New template'}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <label>Name <input aria-label="Template name" value={n} onChange={(e) => setN(e.target.value)} placeholder="Sitcom block" /></label>
        <label>Plays from <select aria-label="Template pool" value={pool} onChange={(e) => setPool(e.target.value)}>{poolNames.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Length, minutes <input aria-label="Template length" type="number" min={grid / 60_000} step={grid / 60_000} value={minutes} placeholder="120" onChange={(e) => setMinutes(e.target.value)} /></label>
      </div>
      <p className="muted small">{poolSummary(pools[pool])}. Left empty, the length is 2 hours.</p>
      <div className="row">
        <label>Link name <input aria-label="Template link name" list="tpllinks" value={link} onChange={(e) => setLink(e.target.value)} placeholder="none" />
          <datalist id="tpllinks">{linkNames.map((l) => <option key={l} value={l} />)}</datalist>
        </label>
        {link.trim() !== '' && (
          <label>Link kind <select aria-label="Template link kind" value={mode} onChange={(e) => setMode(e.target.value as 'continue' | 'rerun')}>
            <option value="continue">continues the same show</option><option value="rerun">reruns it</option>
          </select></label>
        )}
      </div>
      {name && following > 0 && (
        <label><input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Also change the {following} slot{following === 1 ? '' : 's'} on the week placed from it (slots you changed by hand keep their change)</label>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={save}>{name ? 'Save the template' : 'Add the template'}</button>
        <button type="button" onClick={onClose}>Close</button>
        {onDelete && <button type="button" onClick={onDelete}>Delete the template</button>}
      </div>
    </div>
  );
}
