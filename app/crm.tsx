'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, FormEvent, ReactNode } from 'react';
import {
  AlignLeft, ArrowDownRight, ArrowUpRight, BriefcaseBusiness, CalendarDays, CalendarClock, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, ContactRound, Eye, EyeOff, Funnel,
  Kanban, LayoutGrid, List, LoaderCircle, LockKeyhole, LogOut, Menu, Plus, Search, UsersRound,
  Upload, Wallet, X,
} from 'lucide-react';
import type { ActivityInput, CrmUser, Lead, LeadImportReport, LeadInput, SalesUserId, Stage } from './model';
import { bogotaDay, formatDate, formatDay, formatMoney, initials, SALES_USERS, STAGES } from './model';
import { LeadDrawer, LeadEditor, LeadImportPanel } from './lead-panels';

const NAV = [
  { id: 'embudo', label: 'Embudo de ventas', icon: Kanban },
  { id: 'contactos', label: 'Contactos', icon: ContactRound },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'clientes', label: 'Clientes', icon: BriefcaseBusiness },
] as const;
type View = (typeof NAV)[number]['id'];
type FollowUpFilter = 'all' | 'missing-action' | 'overdue';
const PIPELINE = STAGES.slice(0, 4);
const descriptions: Record<View, string> = {
  embudo: 'Organiza tus oportunidades y mantén al día cada seguimiento.',
  contactos: 'Consulta la información y el historial de tus contactos comerciales.',
  agenda: 'Revisa las visitas, demos y próximos seguimientos por fecha.',
  clientes: 'Consulta las ventas confirmadas y el historial de cada cliente.',
};
const isOpen = (lead: Lead) => lead.stage !== 'won' && lead.stage !== 'lost';
const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const tagKey = (value: string) => `tag:${value.toLocaleLowerCase('es-CO')}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Ocurrió un error. Inténtalo de nuevo.';
const userName = (id: SalesUserId) => SALES_USERS.find((user) => user.id === id)?.name ?? 'Sin encargado';
const contactCount = new Intl.NumberFormat('es-CO');

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, method = 'GET', body?: object, idempotencyKey?: string): Promise<T> {
  const file = body instanceof File ? body : undefined;
  const signal = AbortSignal.timeout(file ? 70_000 : 15_000);
  try {
    const response = await fetch(path, {
      method,
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      ...(body && {
        headers: { 'Content-Type': file ? 'application/octet-stream' : 'application/json', ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }) },
        body: file ?? JSON.stringify(body),
      }),
    });
    const result = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok || result === null) {
      throw new RequestError(result?.error ?? 'No se pudo conectar con el CRM. Inténtalo de nuevo.', response.status);
    }
    return result as T;
  } catch (error) {
    if (signal.aborted) throw new Error('El CRM tardó en responder. Inténtalo de nuevo.');
    if (error instanceof TypeError) throw new Error('No se pudo conectar con el CRM. Revisa tu conexión e intenta de nuevo.');
    throw error;
  }
}

function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>BESTO<span className="brand-os">OS</span><small>CRM COMERCIAL</small></span></div>;
}

function Login({ onLogin, initialError }: { onLogin: (user: CrmUser) => void; initialError: string }) {
  const [visible, setVisible] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(initialError);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    const data = new FormData(event.currentTarget);
    setWorking(true);
    setError('');
    try {
      const { user } = await request<{ user: CrmUser }>('/api/session', 'POST', { username: data.get('username'), password: data.get('password') });
      onLogin(user);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setWorking(false);
    }
  }

  return <main className="login-shell">
    <div className="login-aside"><Brand /><div className="login-art" aria-hidden="true"><i /><i /><i /><i /></div><div className="login-aside-copy"><strong>Seguimiento<br />comercial</strong></div></div>
    <div className="login-main"><div className="login-form-wrap">
      <span className="login-icon"><LockKeyhole size={22} /></span>
      <h1>Inicia sesión</h1><p>Accede al espacio comercial de BESTO.</p>
      <form onSubmit={signIn} className="login-form">
        <label>Usuario<input name="username" autoComplete="username" placeholder="Tu usuario" autoCapitalize="none" spellCheck={false} maxLength={30} required /></label>
        <label>Contraseña<span className="password-field"><input name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder="Tu contraseña" maxLength={128} required /><button type="button" className="icon-button" aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button type="submit" className="button primary login-submit" disabled={working}>{working && <LoaderCircle size={18} className="spin" />}Entrar al CRM</button>
      </form>
    </div></div>
  </main>;
}

function Owner({ assignee }: { assignee: SalesUserId }) {
  return <span className="owner"><span className={`avatar ${assignee}`} aria-hidden="true">{initials(userName(assignee))}</span>{userName(assignee)}</span>;
}

function Badge({ stage }: { stage: Stage }) {
  const data = STAGES.find((entry) => entry.id === stage)!;
  return <span className={`stage-badge tone-${data.color}`}><i />{data.label}</span>;
}

function LeadCard({ lead, open, startDrag, endDrag }: { lead: Lead; open: () => void; startDrag: (event: DragEvent) => void; endDrag: () => void }) {
  return <button className="lead-card" onClick={open} draggable onDragStart={startDrag} onDragEnd={endDrag}>
    <span className="card-heading"><strong>{lead.company || lead.name}</strong><ChevronRight size={16} aria-hidden="true" /></span>
    {lead.company && lead.company !== lead.name && <span className="card-person">{lead.name}</span>}
    {lead.tags.length > 0 && <span className="card-tags">{lead.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}{lead.tags.length > 3 && <span>+{lead.tags.length - 3}</span>}</span>}
    {lead.nextFollowUp && <span className="card-date"><CalendarClock size={15} />{formatDate(lead.nextFollowUp)}</span>}
    <span className="card-footer"><Owner assignee={lead.assignee} /><span>{lead.amount !== null && formatMoney(lead.amount)}</span></span>
  </button>;
}

function Empty({ title, description, action }: { title: string; description: string; action?: { label: string; run: () => void } }) {
  return <div className="full-empty"><span><ClipboardList size={24} /></span><strong>{title}</strong><p>{description}</p>{action && <button className="button secondary" onClick={action.run}><Plus size={17} />{action.label}</button>}</div>;
}

function useLeadPage(leads: Lead[], size: number) {
  const [page, setPage] = useState(1);
  const total = Math.max(1, Math.ceil(leads.length / size));
  const current = Math.min(page, total);
  return { items: leads.slice((current - 1) * size, current * size), current, total, setPage };
}

function Pagination({ current, total, setPage }: Omit<ReturnType<typeof useLeadPage>, 'items'>) {
  if (total === 1) return null;
  return <nav className="lead-pagination" aria-label="Páginas de contactos">
    <button type="button" className="icon-button" aria-label="Página anterior" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={17} /></button>
    <span aria-live="polite">{current} de {total}</span>
    <button type="button" className="icon-button" aria-label="Página siguiente" disabled={current === total} onClick={() => setPage(current + 1)}><ChevronRight size={17} /></button>
  </nav>;
}

function LaneItems({ leads, filtered, render }: { leads: Lead[]; filtered: boolean; render: (lead: Lead) => ReactNode }) {
  const { items, ...pagination } = useLeadPage(leads, 20);
  return <>
    <div className="lane-items">{items.length ? items.map(render)
      : <div className="lane-empty"><span>{filtered ? 'Sin coincidencias' : 'Sin oportunidades'}</span></div>}</div>
    <Pagination {...pagination} />
  </>;
}

function LeadTable({ leads, open, view, filtered, create }: { leads: Lead[]; open: (lead: Lead) => void; view: View; filtered: boolean; create: () => void }) {
  const { items, ...pagination } = useLeadPage(leads, 50);
  if (!leads.length) return <Empty
    title={filtered ? 'Sin resultados' : view === 'clientes' ? 'Aún no hay clientes' : 'Aún no hay contactos'}
    description={filtered ? 'Prueba cambiando la búsqueda o los filtros.' : view === 'clientes' ? 'Los leads aparecen aquí cuando confirmas la venta.' : 'Agrega un contacto para iniciar el seguimiento.'}
    action={!filtered && view !== 'clientes' ? { label: 'Agregar contacto', run: create } : undefined}
  />;
  return <><div className="table-scroll"><table className="lead-table">
    <thead><tr><th>Contacto</th><th>Etapa</th><th>Encargado</th><th>Valor</th><th>{view === 'clientes' ? 'Fecha de cierre' : 'Seguimiento'}</th><th><span className="sr-only">Abrir ficha</span></th></tr></thead>
    <tbody>{items.map((lead) => <tr key={lead.id}>
      <td><button onClick={() => open(lead)} className="table-person"><strong>{lead.name}</strong><span>{lead.company || lead.email || lead.phone}</span></button></td>
      <td><Badge stage={lead.stage} /></td><td><Owner assignee={lead.assignee} /></td><td>{formatMoney(lead.amount)}</td>
      <td>{view === 'clientes' ? lead.wonAt && formatDay(lead.wonAt) : lead.nextFollowUp ? formatDate(lead.nextFollowUp) : '—'}</td>
      <td><button className="icon-button" onClick={() => open(lead)} aria-label={`Abrir ficha de ${lead.name}`}><ChevronRight size={18} /></button></td>
    </tr>)}</tbody>
  </table></div><Pagination {...pagination} /></>;
}

function Agenda({ leads, open, filtered }: { leads: Lead[]; open: (lead: Lead) => void; filtered: boolean }) {
  const today = bogotaDay(new Date());
  const now = Date.now();
  const scheduled = leads.filter((lead) => lead.nextFollowUp).sort((a, b) => Date.parse(a.nextFollowUp!) - Date.parse(b.nextFollowUp!));
  const { items, ...pagination } = useLeadPage(scheduled, 50);
  const groups = new Map<string, Lead[]>();
  for (const lead of items) {
    const day = bogotaDay(lead.nextFollowUp!);
    const list = groups.get(day) ?? [];
    list.push(lead);
    groups.set(day, list);
  }
  if (!scheduled.length) return <Empty title="Sin seguimientos agendados" description={filtered ? 'Cambia los filtros para consultar más seguimientos.' : 'Abre una ficha y agrega una fecha de seguimiento para verla aquí.'} />;
  return <><div className="agenda-groups">{[...groups].map(([day, list]) => <section className="agenda-group" key={day}>
    <h3>{day === today ? 'Hoy' : formatDay(list[0].nextFollowUp!)} {day < today && <span className="overdue">Vencidos</span>}</h3>
    {list.map((lead) => <button type="button" className="agenda-row" key={lead.id} onClick={() => open(lead)}><span className="agenda-icon"><CalendarClock size={18} /></span><span className="agenda-name"><strong>{lead.nextAction || 'Seguimiento'}</strong><small>{lead.company ? `${lead.company} · ${lead.name}` : lead.name}</small></span><Owner assignee={lead.assignee} /><span className={`agenda-date${day === today && Date.parse(lead.nextFollowUp!) < now ? ' agenda-late' : ''}`}>{formatDate(lead.nextFollowUp!)}</span><ChevronRight size={18} /></button>)}
  </section>)}</div><Pagination {...pagination} /></>;
}

export function Crm() {
  const [user, setUser] = useState<CrmUser | null | undefined>(undefined);
  const [authError, setAuthError] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('embudo');
  const [layout, setLayout] = useState<'board' | 'list'>('board');
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('all');
  const [tag, setTag] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [followUp, setFollowUp] = useState<FollowUpFilter>('all');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ lead?: Lead; initialStage?: Stage; focus?: 'followup' } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<Stage | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const activeRequest = useRef(0);
  const sessionRevision = useRef(0);
  const lastPost = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    request<{ user: CrmUser | null }>('/api/session').then(({ user }) => setUser(user)).catch((error) => {
      setAuthError(messageOf(error));
      setUser(null);
    });
  }, []);

  const clearSession = useCallback(() => {
    activeRequest.current++;
    sessionRevision.current++;
    lastPost.current = null;
    setUser(null);
    setLeads([]);
    setLoadState('idle');
    setLoadError('');
    setDrawer(null);
    setEditor(null);
    setImportOpen(false);
    setOwner('all');
    setTag('all');
    setQuery('');
    setStageFilter('all');
    setFollowUp('all');
    setView('embudo');
    setLayout('board');
    setDraggedId(null);
    setDropStage(null);
    setMobileMenu(false);
    setNotice(null);
  }, []);

  const loadLeads = useCallback(async (silent = false) => {
    const id = ++activeRequest.current;
    if (!silent) setLoadState('loading');
    try {
      const leads: Lead[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const page: { leads: Lead[]; nextCursor: string | null } = await request(`/api/leads?after=${cursor}`);
        if (id !== activeRequest.current) return;
        leads.push(...page.leads);
        cursor = page.nextCursor;
      }
      leads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      if (id === activeRequest.current) {
        setLeads((previous) => {
          const previousById = new Map(previous.map((lead) => [lead.id, lead]));
          return leads.map((lead) => {
            const latest = previousById.get(lead.id);
            return latest && latest.revision > lead.revision ? latest : lead;
          });
        });
        setLoadState('ready');
      }
    } catch (error) {
      if (id !== activeRequest.current) return;
      if (error instanceof RequestError && error.status === 401) {
        setAuthError('Tu sesión terminó. Inicia sesión de nuevo.');
        clearSession();
      } else {
        setLoadError(messageOf(error));
        setLoadState((state) => silent && state === 'ready' ? state : 'error');
      }
    }
  }, [clearSession]);

  useEffect(() => {
    if (!user) return;
    void loadLeads();
    const onFocus = () => void loadLeads(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadLeads, user]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === 'error' ? 9000 : 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const editorUnavailable = Boolean(editor?.lead && !leads.some((lead) => lead.id === editor.lead?.id));
  useEffect(() => {
    if (!editorUnavailable) return;
    setEditor(null);
    setDrawer(null);
    setNotice({ text: 'El contacto dejó de estar disponible.', kind: 'error' });
  }, [editorUnavailable]);

  function changeView(next: View) {
    setView(next);
    setMobileMenu(false);
    setDrawer(null);
    setQuery('');
    setTag('all');
    setStageFilter('all');
    setFollowUp('all');
    setNotice(null);
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await request('/api/session', 'DELETE');
      setAuthError('');
      clearSession();
    } catch (error) {
      setNotice({ text: messageOf(error), kind: 'error' });
    } finally {
      setSigningOut(false);
    }
  }

  function updateLead(lead: Lead) {
    setLeads((previous) => previous.some((item) => item.id === lead.id && item.revision > lead.revision)
      ? previous : [lead, ...previous.filter((item) => item.id !== lead.id)]);
  }

  async function uploadLeads(file: File, assignee: SalesUserId, confirm: boolean) {
    const format = file.name.split('.').pop()?.toLowerCase() ?? '';
    const query = new URLSearchParams({ format, assignee, confirm: confirm ? '1' : '0' });
    try {
      const result = await request<LeadImportReport>(`/api/leads/import?${query}`, 'POST', file);
      if (confirm) void loadLeads(true);
      return result;
    } catch (error) {
      if (error instanceof RequestError && error.status === 401) {
        setAuthError('Tu sesión terminó. Inicia sesión de nuevo.');
        clearSession();
      }
      throw error;
    }
  }

  async function mutateLead(path: string, method: 'POST' | 'PATCH', payload: object) {
    const revision = sessionRevision.current;
    const fingerprint = `${path}:${JSON.stringify(payload)}`;
    if (method === 'POST' && lastPost.current?.fingerprint !== fingerprint) {
      lastPost.current = { fingerprint, key: crypto.randomUUID() };
    }
    const key = method === 'POST' ? lastPost.current?.key : undefined;
    try {
      const { lead } = await request<{ lead: Lead }>(path, method, payload, key);
      if (revision !== sessionRevision.current) throw new Error('Tu sesión cambió.');
      if (key === lastPost.current?.key) lastPost.current = null;
      updateLead(lead);
      void loadLeads(true);
      return lead;
    } catch (error) {
      if (revision !== sessionRevision.current) throw error;
      if (error instanceof RequestError && [404, 409].includes(error.status)) void loadLeads(true);
      if (error instanceof RequestError && error.status === 401) {
        setAuthError('Tu sesión terminó. Inicia sesión de nuevo.');
        clearSession();
      }
      throw error;
    }
  }

  async function saveLead(input: LeadInput) {
    if (!editor) return;
    const previous = editor.lead;
    const lead = previous
      ? await mutateLead(`/api/leads/${previous.id}`, 'PATCH', { ...input, revision: previous.revision }).catch((error) => {
        if (error instanceof RequestError && error.status === 409) {
          throw new Error('El contacto cambió en otra sesión. Cierra el editor y vuelve a abrir la ficha para ver los cambios.');
        }
        throw error;
      })
      : await mutateLead('/api/leads', 'POST', input);
    setEditor(null);
    const won = lead.stage === 'won' && previous?.stage !== 'won';
    setDrawer(lead.id);
    setNotice({ text: won ? 'Venta confirmada. El contacto ya está en Clientes.' : previous ? 'Contacto actualizado.' : 'Contacto agregado al CRM.', kind: 'success' });
  }

  async function moveLead(lead: Lead, stage: Stage) {
    if (lead.stage === stage) return;
    await mutateLead(`/api/leads/${lead.id}`, 'PATCH', { stage, revision: lead.revision });
    const won = stage === 'won';
    setNotice({ text: won ? 'Venta confirmada. El contacto ya está en Clientes.' : 'Etapa actualizada.', kind: 'success' });
  }

  function drop(event: DragEvent<HTMLDivElement>, stage: Stage) {
    event.preventDefault();
    const lead = leads.find((item) => item.id === draggedId);
    setDraggedId(null);
    setDropStage(null);
    const revision = sessionRevision.current;
    if (lead) void moveLead(lead, stage).catch((error) => {
      if (revision === sessionRevision.current) setNotice({ text: messageOf(error), kind: 'error' });
    });
  }

  const scoped = leads.filter((lead) => owner === 'all' || lead.assignee === owner);
  const openLeads = scoped.filter(isOpen);
  const customers = scoped.filter((lead) => lead.stage === 'won');
  const portfolio = openLeads.reduce((total, lead) => total + (lead.amount ?? 0), 0);
  const upcoming = openLeads.filter((lead) => lead.nextFollowUp);
  const now = Date.now();
  const isOverdue = (lead: Lead) => Boolean(lead.nextFollowUp && Date.parse(lead.nextFollowUp) < now);
  const overdue = upcoming.filter(isOverdue).length;
  const base = view === 'embudo' ? openLeads : view === 'clientes' ? customers : view === 'agenda' ? upcoming : scoped;
  const tags = new Map<string, string>();
  for (const lead of base) {
    for (const value of lead.tags) {
      const key = tagKey(value);
      if (!tags.has(key)) tags.set(key, value);
    }
  }
  const tagOptions = [...tags].sort(([, a], [, b]) => a.localeCompare(b, 'es-CO'));
  const activeTag = tags.has(tag) ? tag : 'all';
  useEffect(() => {
    if (tag !== activeTag) setTag(activeTag);
  }, [tag, activeTag]);

  if (user === undefined) return <main className="app-loading"><Brand /><LoaderCircle className="spin" size={23} /><span className="sr-only">Cargando CRM</span></main>;
  if (!user) return <Login onLogin={(next) => { setLoadState('loading'); setAuthError(''); setUser(next); }} initialError={authError} />;

  const term = normalize(query.trim());
  const filtered = Boolean(term || activeTag !== 'all' || owner !== 'all' || stageFilter !== 'all' || followUp !== 'all');
  const shown = base.filter((lead) => (!term || normalize([lead.name, lead.company, lead.phone, lead.email, lead.role, lead.source,
    lead.imported?.code, lead.imported?.activity, lead.imported?.unverifiedEmail, ...lead.tags].join(' ')).includes(term))
    && (activeTag === 'all' || lead.tags.some((value) => tagKey(value) === activeTag))
    && (stageFilter === 'all' || lead.stage === stageFilter)
    && (followUp !== 'missing-action' || !lead.nextAction?.trim())
    && (followUp !== 'overdue' || isOverdue(lead)));
  const selected = leads.find((lead) => lead.id === drawer);
  const pageKey = JSON.stringify([view, term, owner, activeTag, stageFilter, followUp]);
  const label = NAV.find((item) => item.id === view)!.label;
  const listLabel = view === 'agenda' ? 'Próximos seguimientos' : view === 'clientes' ? 'Ventas confirmadas' : view === 'contactos' ? 'Directorio de contactos' : 'Oportunidades por etapa';
  const metrics = [
    { icon: Funnel, tone: 'orange', label: 'Leads activos', value: openLeads.length, detail: 'En el embudo' },
    { icon: CalendarClock, tone: 'violet', label: 'Seguimientos', value: upcoming.length, detail: overdue ? `${overdue} vencido${overdue === 1 ? '' : 's'}` : 'Con fecha agendada' },
    { icon: Wallet, tone: 'blue', label: 'Valor en juego', value: formatMoney(portfolio), detail: 'Oportunidades abiertas · COP' },
    { icon: UsersRound, tone: 'green', label: 'Clientes', value: customers.length, detail: 'Ventas confirmadas' },
  ];

  return <div className="app-shell">
    {mobileMenu && <button className="mobile-scrim" aria-label="Cerrar navegación" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar${mobileMenu ? ' sidebar-open' : ''}`}>
      <Brand />
      <nav aria-label="Principal"><p>ESPACIO COMERCIAL</p>{NAV.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => changeView(id)} aria-current={view === id ? 'page' : undefined}><Icon size={19} /><span>{label}</span>{view === id && <span className="nav-indicator" aria-hidden="true" />}</button>)}</nav>
      <div className="sidebar-footer"><div className={`avatar profile-avatar ${user.id}`} aria-hidden="true">{initials(user.name)}</div><span><strong>{user.name}</strong><small>{user.role === 'manager' ? 'Encargado de ventas' : 'Ventas'}</small></span><button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={signOut} disabled={signingOut}><LogOut size={18} /></button></div>
    </aside>
    <div className="app-main">
      <header className="topbar"><button className="icon-button menu-toggle" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Abrir navegación" aria-expanded={mobileMenu}><Menu size={22} /></button><div className="breadcrumb"><span>Comercial</span><ChevronRight size={15} /><strong>{label}</strong></div><span className="topbar-context"><span />{user.role === 'manager' ? 'Vista de equipo' : 'Mis leads'}</span></header>
      <main className="workspace">
        <div className="page-heading"><div><h1>{label}</h1><p>{descriptions[view]}</p></div><div className="workspace-actions">
          {(view === 'embudo' || view === 'contactos') && user.role === 'manager' && <button type="button" className="button secondary" onClick={() => setImportOpen(true)}><Upload size={17} />Importar contactos</button>}
          <button className="button primary" onClick={() => setEditor({})} disabled={loadState !== 'ready'}><Plus size={19} />Nuevo lead</button>
        </div></div>
        {view === 'embudo' && <section className="metrics" aria-label="Indicadores comerciales">{metrics.map(({ icon: Icon, tone, label, value, detail }) => <article className="metric" key={label}><div className="metric-title"><span className={`stat-icon tone-${tone}`}><Icon size={17} /></span><h2>{label}</h2></div><strong>{loadState === 'ready' ? value : '—'}</strong><small>{detail}</small></article>)}</section>}
        <section className="work-panel" aria-label={listLabel}>
          <div className="panel-heading"><div><div className="panel-title"><h2>{listLabel}</h2>{loadState === 'ready' && <span className="result-count">{contactCount.format(shown.length)}</span>}</div></div>
            {view === 'embudo' && <div className="view-switch" aria-label="Vista de oportunidades"><button onClick={() => setLayout('board')} aria-label="Vista de tablero" aria-pressed={layout === 'board'} title="Tablero"><LayoutGrid size={17} /><span>Tablero</span></button><button onClick={() => setLayout('list')} aria-label="Vista de lista" aria-pressed={layout === 'list'} title="Lista"><List size={17} /><span>Lista</span></button></div>}
          </div>
          <div className="toolbar">
            <label className="search-field"><Search size={18} /><span className="sr-only">Buscar contactos</span><input ref={search} type="search" placeholder="Buscar contacto o negocio…" value={query} onChange={(event) => setQuery(event.target.value)} />{!query && <kbd>Ctrl K</kbd>}</label>
            <div className="filters">
              {user.role === 'manager' && <label className="filter-select"><UsersRound size={16} /><span className="sr-only">Encargado</span><select value={owner} onChange={(event) => { setOwner(event.target.value); setTag('all'); }}><option value="all">Todos los encargados</option>{SALES_USERS.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><ChevronDown size={13} /></label>}
              <label className="filter-select"><Funnel size={16} /><span className="sr-only">Etiqueta</span><select value={activeTag} onChange={(event) => setTag(event.target.value)}><option value="all">Etiquetas</option>{tagOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select><ChevronDown size={13} /></label>
              {view === 'embudo' && <label className="filter-select"><CalendarClock size={16} /><span className="sr-only">Seguimiento</span><select value={followUp} onChange={(event) => setFollowUp(event.target.value as FollowUpFilter)}><option value="all">Todos los seguimientos</option><option value="missing-action">Sin próxima acción</option><option value="overdue">Seguimiento vencido</option></select><ChevronDown size={13} /></label>}
              {view === 'contactos' && <label className="filter-select"><AlignLeft size={16} /><span className="sr-only">Etapa</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="all">Todas las etapas</option>{STAGES.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}</select><ChevronDown size={13} /></label>}
            </div>
          </div>
          {loadState === 'error' ? <div className="full-empty" role="alert"><span><CircleAlert size={24} /></span><strong>No pudimos cargar el CRM</strong><p>{loadError}</p><button className="button secondary" onClick={() => void loadLeads()}>Reintentar</button></div>
            : loadState !== 'ready' ? <div className="full-empty" role="status"><LoaderCircle className="spin" size={25} /><p>Cargando contactos…</p></div>
            : view === 'embudo' && layout === 'board' ? <div className="board-scroll"><div className="board">
              {PIPELINE.map((stage) => {
                const items = shown.filter((lead) => lead.stage === stage.id);
                return <div key={stage.id} className={`lane tone-${stage.color}${dropStage === stage.id ? ' lane-drop' : ''}`}
                  onDragOver={(event) => { if (draggedId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropStage(stage.id); } }} onDrop={(event) => drop(event, stage.id)}>
                  <div className="lane-heading"><span className="lane-dot" /><h3>{stage.label}</h3><span className="lane-count">{contactCount.format(items.length)}</span><button className="icon-button" aria-label={`Nuevo lead en ${stage.label}`} onClick={() => setEditor({ initialStage: stage.id })}><Plus size={18} /></button></div>
                  <p className="lane-description">{stage.description}</p>
                  <LaneItems key={pageKey} leads={items} filtered={filtered} render={(lead) => <LeadCard key={lead.id} lead={lead} open={() => setDrawer(lead.id)} startDrag={(event) => { event.dataTransfer.setData('text/plain', lead.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(lead.id); }} endDrag={() => { setDraggedId(null); setDropStage(null); }} />} />
                  <button className="lane-add" onClick={() => setEditor({ initialStage: stage.id })}><Plus size={16} />Agregar lead</button>
                </div>;
              })}
            </div></div> : view === 'agenda' ? <Agenda key={pageKey} leads={shown} open={(lead) => setDrawer(lead.id)} filtered={filtered} /> : <LeadTable key={pageKey} leads={shown} open={(lead) => setDrawer(lead.id)} view={view} filtered={filtered} create={() => setEditor({})} />}
        </section>
        {view === 'embudo' && <div className="board-note"><span><ArrowDownRight size={17} />Arrastra una tarjeta o abre su ficha para cambiar de etapa.</span><button onClick={() => changeView('clientes')}>Ver clientes <ArrowUpRight size={15} /></button></div>}
      </main>
    </div>
    {selected && !editor && <LeadDrawer key={selected.id} currentUser={user} lead={selected}
      statusMessage={notice?.kind === 'success' ? notice.text : undefined}
      onClose={() => { setDrawer(null); setNotice(null); }}
      onEdit={(focus) => { setNotice(null); setEditor({ lead: selected, focus }); }}
      onViewClients={() => changeView('clientes')}
      onStage={(stage) => moveLead(selected, stage)}
      onActivity={async (input: ActivityInput) => { await mutateLead(`/api/leads/${selected.id}/activities`, 'POST', input); }} />}
    {editor && !editorUnavailable && <LeadEditor {...editor} currentUser={user} onClose={() => setEditor(null)} onSave={saveLead} />}
    {importOpen && user.role === 'manager' && <LeadImportPanel currentUser={user} onClose={() => setImportOpen(false)} onUpload={uploadLeads} />}
    {notice && !selected && !editor && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}<span>{notice.text}</span><button className="icon-button" type="button" onClick={() => setNotice(null)} aria-label="Cerrar aviso"><X size={16} /></button></div>}
  </div>;
}
