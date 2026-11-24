"use client";

import {
  CalendarDays,
  Check,
  ChevronDown,
  CircleCheck,
  ClipboardList,
  Clock3,
  Mail,
  MessageCircle,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  Send,
  Tags,
  UserRoundPlus,
  X,
} from "lucide-react";
import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type Activity,
  type ActivityInput,
  type CrmUser,
  type Lead,
  type LeadInput,
  type SalesUserId,
  type Stage,
  SALES_USERS,
  SOURCES,
  STAGES,
  formatDate,
  formatDay,
  formatMoney,
  initials,
} from "./model";
import "./lead-panels.css";

const activityOptions = {
  note: { label: "Nota", icon: NotebookPen, placeholder: "Anota lo que debes recordar sobre este contacto." },
  whatsapp: { label: "WhatsApp", icon: MessageCircle, placeholder: "Escribe o pega el mensaje de WhatsApp." },
  call: { label: "Llamada", icon: Phone, placeholder: "Resume lo conversado en la llamada." },
  meeting: { label: "Reunión", icon: CalendarDays, placeholder: "Registra los acuerdos de la reunión o la visita." },
  email: { label: "Correo", icon: Mail, placeholder: "Escribe o pega el correo." },
} satisfies Record<ActivityInput["kind"], { label: string; icon: typeof Phone; placeholder: string }>;

const stageIcons = {
  created: { label: "Contacto creado", icon: UserRoundPlus },
  stage: { label: "Cambio de etapa", icon: ClipboardList },
};

const activityKinds = Object.keys(activityOptions) as ActivityInput["kind"][];
const maxTags = 20;
const maxTagLength = 30;
const bogotaDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Bogota",
  dateStyle: "short",
  timeStyle: "short",
  hourCycle: "h23",
});
function inputDate(iso: string | null | undefined) {
  return iso ? bogotaDate.format(new Date(iso)).replace(" ", "T") : "";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function whatsappNumber(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (/^3\d{9}$/.test(digits)) return `57${digits}`;
  if ((phone.trim().startsWith("+") || digits.startsWith("57")) && /^\d{9,15}$/.test(digits)) return digits;
  return null;
}

function SelectField({ children, ...props }: ComponentProps<"select">) {
  return (
    <span className="lead-panel-select">
      <select {...props}>{children}</select>
      <ChevronDown aria-hidden="true" size={16} />
    </span>
  );
}

function Panel({
  title,
  subtitle,
  onClose,
  busy,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const initialField = dialog.querySelector<HTMLElement>("[data-panel-initial-focus]");
    initialField?.focus();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`lead-panel ${className}`}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom
          ) onClose();
        }
      }}
    >
      <div className="lead-panel-inner">
        <header className="lead-panel-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={subtitleId}>{subtitle}</p>}
          </div>
          <button type="button" className="lead-panel-icon-button" onClick={onClose} disabled={busy} aria-label="Cerrar panel">
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function LeadEditor({
  lead,
  initialStage = "new",
  currentUser,
  focus,
  onClose,
  onSave,
}: {
  lead?: Lead;
  initialStage?: Stage;
  currentUser: CrmUser;
  focus?: "followup";
  onClose: () => void;
  onSave: (input: LeadInput) => Promise<void>;
}) {
  const [tags, setTags] = useState(lead?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const tagErrorId = useId();
  const tagInputId = useId();
  const tagRef = useRef<HTMLInputElement>(null);

  function mergeTags() {
    const pendingTags = tagInput.split(",").map((tag) => tag.trim()).filter(Boolean);
    const added = [...new Map([...tags, ...pendingTags].map((tag) => [tag.toLocaleLowerCase("es-CO"), tag])).values()];

    if (added.some((tag) => tag.length > maxTagLength)) {
      setTagError(`Cada etiqueta puede tener hasta ${maxTagLength} caracteres.`);
      tagRef.current?.focus();
      return null;
    }

    if (added.length > maxTags) {
      setTagError(`Puedes agregar hasta ${maxTags} etiquetas.`);
      tagRef.current?.focus();
      return null;
    }

    setTagError("");
    setTags(added);
    setTagInput("");
    return added;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const currentTags = mergeTags();
    if (!currentTags) return;
    const values = new FormData(event.currentTarget);
    const field = (key: string) => String(values.get(key) ?? "").trim();
    const date = field("nextFollowUp");
    const amount = field("amount");

    if (!field("name")) {
      setError("Escribe el nombre del contacto.");
      event.currentTarget.querySelector<HTMLInputElement>('[name="name"]')?.focus();
      return;
    }

    saving.current = true;
    setBusy(true);
    setError("");

    try {
      let nextFollowUp = lead?.nextFollowUp ?? null;
      if (date !== inputDate(nextFollowUp)) {
        nextFollowUp = date ? new Date(`${date}:00-05:00`).toISOString() : null;
      }

      await onSave({
        name: field("name"),
        company: field("company"),
        role: field("role"),
        phone: field("phone"),
        email: field("email"),
        source: field("source"),
        tags: currentTags,
        amount: amount ? Number(amount) : null,
        stage: field("stage") as Stage,
        assignee: currentUser.role === "manager" ? field("assignee") as SalesUserId : currentUser.id,
        nextFollowUp,
        nextAction: field("nextAction"),
      });
    } catch (cause) {
      setError(errorMessage(cause, "No se pudo guardar el contacto. Vuelve a intentarlo."));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Panel
      title={lead ? "Editar contacto" : "Nuevo lead"}
      subtitle={lead ? lead.name : "Agrega los datos para iniciar el seguimiento comercial."}
      onClose={onClose}
      busy={busy}
      className="lead-panel-editor"
    >
      <form className="lead-panel-form" onSubmit={save} aria-busy={busy || undefined}>
        <div className="lead-panel-scroll">
          <fieldset className="lead-panel-fields" disabled={busy}>
            <legend>Datos del contacto</legend>
            <div className="lead-panel-grid">
              <label>
                <span>Nombre completo <span className="lead-panel-required">*</span></span>
                <input name="name" required maxLength={120} defaultValue={lead?.name} data-panel-initial-focus={focus !== "followup" ? true : undefined} placeholder="Nombre y apellido" autoComplete="off" />
              </label>
              <label>
                <span>Empresa o negocio</span>
                <input name="company" maxLength={120} defaultValue={lead?.company} placeholder="Nombre del negocio" autoComplete="off" />
              </label>
              <label>
                <span>Teléfono o WhatsApp</span>
                <input name="phone" type="tel" maxLength={60} defaultValue={lead?.phone} placeholder="+57 300 000 0000" autoComplete="off" />
              </label>
              <label>
                <span>Correo</span>
                <input name="email" type="email" maxLength={254} defaultValue={lead?.email} placeholder="nombre@empresa.com" autoComplete="off" />
              </label>
              <label>
                <span>Cargo</span>
                <input name="role" maxLength={100} defaultValue={lead?.role} placeholder="Ej. Propietario" />
              </label>
              <label>
                <span>Origen del contacto</span>
                <SelectField name="source" defaultValue={lead?.source || ""}>
                  <option value="">Selecciona el origen</option>
                  {lead?.source && !SOURCES.includes(lead.source) && <option>{lead.source}</option>}
                  {SOURCES.map((source) => <option key={source}>{source}</option>)}
                </SelectField>
              </label>
            </div>
          </fieldset>

          <fieldset className="lead-panel-fields" disabled={busy}>
            <legend>Seguimiento comercial</legend>
            <div className="lead-panel-grid">
              <label>
                <span>Etapa</span>
                <SelectField name="stage" defaultValue={lead?.stage ?? initialStage}>
                  {STAGES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </SelectField>
              </label>
              <label>
                <span>Valor de la oportunidad (COP)</span>
                <input name="amount" type="number" inputMode="decimal" min={0} step="any" max={1000000000000} defaultValue={lead?.amount ?? ""} placeholder="0" />
              </label>
              <label>
                <span>Responsable</span>
                {currentUser.role === "manager" ? (
                  <SelectField name="assignee" defaultValue={lead?.assignee ?? currentUser.id}>
                    {SALES_USERS.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                  </SelectField>
                ) : (
                  <input value={currentUser.name} readOnly className="lead-panel-static-field" />
                )}
              </label>
              <label>
                <span>Fecha y hora de seguimiento</span>
                <input
                  name="nextFollowUp"
                  type="datetime-local"
                  min="0001-01-01T00:00"
                  max="9999-12-31T23:59"
                  defaultValue={inputDate(lead?.nextFollowUp)}
                  data-panel-initial-focus={focus === "followup" ? true : undefined}
                />
                <small>Hora de Colombia</small>
              </label>
              <label className="lead-panel-full">
                <span>Próxima acción</span>
                <input name="nextAction" maxLength={500} defaultValue={lead?.nextAction} placeholder="Ej. Llamar para confirmar la visita" />
              </label>
              <div className="lead-panel-full">
                <label htmlFor={tagInputId}>Etiquetas</label>
                <div className="lead-panel-tag-field">
                  <input
                    ref={tagRef}
                    id={tagInputId}
                    value={tagInput}
                    aria-describedby={tagError ? tagErrorId : undefined}
                    aria-invalid={!!tagError}
                    onChange={(event) => {
                      setTagInput(event.target.value);
                      setTagError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        mergeTags();
                      }
                    }}
                    placeholder="Escribe una o varias, separadas por comas"
                  />
                  <button type="button" className="lead-panel-button lead-panel-secondary" onClick={mergeTags} disabled={!tagInput.trim()}>
                    <Plus size={16} aria-hidden="true" /> Añadir
                  </button>
                </div>
                {tagError && <small id={tagErrorId} className="lead-panel-field-error" role="alert">{tagError}</small>}
                {tags.length > 0 && (
                  <div className="lead-panel-tags">
                    {tags.map((tag) => (
                      <button type="button" className="lead-panel-tag" key={tag} onClick={() => {
                        setTags(tags.filter((value) => value !== tag));
                        setTagError("");
                      }} aria-label={`Quitar etiqueta ${tag}`}>
                        {tag} <X size={13} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </fieldset>
          {error && <p className="lead-panel-alert" role="alert">{error}</p>}
        </div>
        <footer className="lead-panel-footer">
          <button type="button" className="lead-panel-button lead-panel-secondary" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="lead-panel-button lead-panel-primary" disabled={busy}>
            {lead ? <Check size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}
            {busy ? "Guardando…" : lead ? "Guardar cambios" : "Crear lead"}
          </button>
        </footer>
      </form>
    </Panel>
  );
}

function ActivityEntry({ activity }: { activity: Activity }) {
  const definition = activity.kind === "stage" || activity.kind === "created"
    ? stageIcons[activity.kind]
    : activityOptions[activity.kind];
  const Icon = definition.icon;
  const author = SALES_USERS.find(({ id }) => id === activity.author)?.name;

  return (
    <li className="lead-panel-event">
      <span className={`lead-panel-event-icon lead-panel-event-${activity.kind}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div>
        <div className="lead-panel-event-heading">
          <strong>{definition.label}{activity.direction && ` · ${activity.direction === "sent" ? "Envío" : "Recepción"}`}</strong>
          <span className="lead-panel-event-meta">
            {author && `${author} · `}<time dateTime={activity.createdAt}>{formatDate(activity.createdAt)}</time>
          </span>
        </div>
        <p>{activity.body}</p>
      </div>
    </li>
  );
}

export function LeadDrawer({
  lead,
  currentUser,
  onClose,
  onEdit,
  onStage,
  onActivity,
}: {
  lead: Lead;
  currentUser: CrmUser;
  onClose: () => void;
  onEdit: (focus?: "followup") => void;
  onStage: (stage: Stage) => Promise<void>;
  onActivity: (input: ActivityInput) => Promise<void>;
}) {
  const [kind, setKind] = useState<ActivityInput["kind"]>("note");
  const [direction, setDirection] = useState<"sent" | "received">("sent");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"stage" | "activity" | null>(null);
  const [stageError, setStageError] = useState("");
  const [activityError, setActivityError] = useState("");
  const inFlight = useRef(false);
  const confirmTitle = useRef<HTMLHeadingElement>(null);
  const confirmTrigger = useRef<HTMLElement | null>(null);
  const stageControl = useRef<HTMLSelectElement>(null);
  const saleControl = useRef<HTMLButtonElement>(null);
  const stageId = useId();
  const kindId = useId();
  const directionId = useId();
  const bodyId = useId();
  const confirmTitleId = useId();
  const stage = STAGES.find(({ id }) => id === lead.stage);
  const assignee = lead.assignee === currentUser.id
    ? currentUser.name
    : SALES_USERS.find(({ id }) => id === lead.assignee)?.name;
  const phone = whatsappNumber(lead.phone);
  const messages = kind === "whatsapp" || kind === "email";
  const sortedActivities = [...lead.activities].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  useEffect(() => {
    if (confirming) {
      confirmTitle.current?.focus();
    } else if (confirmTrigger.current) {
      const target = confirmTrigger.current;
      (target.isConnected ? target : saleControl.current ?? stageControl.current)?.focus();
      confirmTrigger.current = null;
    }
  }, [confirming]);

  function openConfirmation(trigger: HTMLElement) {
    confirmTrigger.current = trigger;
    setConfirming(true);
    setStageError("");
  }

  async function changeStage(next: Stage) {
    if (next === lead.stage || inFlight.current) return;
    inFlight.current = true;
    setBusy("stage");
    setStageError("");

    try {
      await onStage(next);
      setConfirming(false);
    } catch (cause) {
      setStageError(errorMessage(cause, "No se pudo cambiar la etapa. Vuelve a intentarlo."));
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  async function saveActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim() || inFlight.current) return;
    inFlight.current = true;
    setBusy("activity");
    setActivityError("");

    try {
      await onActivity({ kind, body: body.trim(), ...(messages ? { direction } : {}) });
      setBody("");
    } catch (cause) {
      setActivityError(errorMessage(cause, "No se pudo registrar la actividad. Vuelve a intentarlo."));
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  return (
    <Panel
      title={lead.stage === "won" ? "Ficha de cliente" : "Ficha del lead"}
      onClose={onClose}
      busy={!!busy}
    >
      <div className="lead-panel-scroll lead-panel-detail">
        <section className="lead-panel-identity" aria-label="Información del contacto">
          <div className="lead-panel-avatar" aria-hidden="true">{initials(lead.name)}</div>
          <div className="lead-panel-identity-text">
            <h3>{lead.name}</h3>
            {(lead.company || lead.role) && <p>{[lead.company, lead.role].filter(Boolean).join(" · ")}</p>}
          </div>
          <button type="button" onClick={() => onEdit()} disabled={!!busy} className="lead-panel-button lead-panel-secondary">
            <Pencil size={16} aria-hidden="true" /> Editar
          </button>
        </section>

        {lead.tags.length > 0 && (
          <div className="lead-panel-tags lead-panel-detail-tags" aria-label="Etiquetas">
            <Tags size={16} aria-hidden="true" />
            {lead.tags.map((tag) => <span className="lead-panel-tag" key={tag}>{tag}</span>)}
          </div>
        )}

        <div className="lead-panel-contact">
          {lead.phone && (
            <a href={`tel:${lead.phone.replace(/[^+\d]/g, "")}`} title="Llamar">
              <Phone size={16} aria-hidden="true" /> <span>{lead.phone}</span>
            </a>
          )}
          {lead.email && (
            <a href={`mailto:${encodeURIComponent(lead.email).replace("%40", "@")}`} title="Enviar correo">
              <Mail size={16} aria-hidden="true" /> <span>{lead.email}</span>
            </a>
          )}
          {phone && (
            <a className="lead-panel-whatsapp" href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer" aria-label="Abrir WhatsApp en otra pestaña">
              <MessageCircle size={16} aria-hidden="true" /> <span>Abrir WhatsApp</span>
            </a>
          )}
        </div>

        <section className="lead-panel-summary" aria-label="Seguimiento comercial">
          <div className="lead-panel-summary-cell">
            <label htmlFor={stageId}><span aria-hidden="true" className={`lead-panel-stage-dot lead-panel-stage-${stage?.color ?? "slate"}`} /> Etapa</label>
            <SelectField
              id={stageId}
              ref={stageControl}
              value={lead.stage}
              onChange={(event) => {
                const next = event.target.value as Stage;
                if (next === "won") {
                  openConfirmation(event.currentTarget);
                } else {
                  setConfirming(false);
                  void changeStage(next);
                }
              }}
              disabled={!!busy}
            >
              {STAGES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </SelectField>
          </div>
          <div className="lead-panel-summary-cell">
            <span>{lead.stage === "won" ? "Valor de la venta" : "Valor de la oportunidad"}</span>
            <strong>{lead.amount === null ? "Sin registrar" : formatMoney(lead.amount)}</strong>
          </div>
          <div className="lead-panel-summary-cell">
            <span>Origen</span>
            <strong>{lead.source || "Sin registrar"}</strong>
          </div>
          <div className="lead-panel-summary-cell">
            <span>Responsable</span>
            <strong>{assignee ?? "Sin asignar"}</strong>
          </div>
          {lead.wonAt && (
            <div className="lead-panel-summary-cell">
              <span>Venta confirmada</span>
              <strong>{formatDay(lead.wonAt)}</strong>
            </div>
          )}
        </section>

        {stageError && <p className="lead-panel-alert" role="alert">{stageError}</p>}
        {lead.stage !== "won" && (
          confirming ? (
            <section className="lead-panel-confirm" aria-labelledby={confirmTitleId}>
              <div>
                <h3 id={confirmTitleId} ref={confirmTitle} tabIndex={-1}>Confirmar venta</h3>
                <p>El contacto pasará a Clientes y conservará su historial.</p>
              </div>
              <div className="lead-panel-confirm-actions">
                <button type="button" className="lead-panel-button lead-panel-secondary" onClick={() => {
                  setConfirming(false);
                  setStageError("");
                }} disabled={!!busy}>Cancelar</button>
                <button type="button" className="lead-panel-button lead-panel-primary" onClick={() => void changeStage("won")} disabled={!!busy}>
                  {busy === "stage" ? "Confirmando…" : "Confirmar"}
                </button>
              </div>
            </section>
          ) : (
            <button type="button" className="lead-panel-button lead-panel-sale" ref={saleControl} onClick={(event) => openConfirmation(event.currentTarget)} disabled={!!busy}>
              <CircleCheck size={17} aria-hidden="true" /> Confirmar venta
            </button>
          )
        )}

        <section className="lead-panel-next" aria-label="Próximo seguimiento">
          <span className="lead-panel-next-icon"><CalendarDays size={19} aria-hidden="true" /></span>
          <div className="lead-panel-next-details">
            <h3>{lead.nextAction || "Próximo seguimiento"}</h3>
            {lead.nextFollowUp
              ? <time dateTime={lead.nextFollowUp}><Clock3 size={14} aria-hidden="true" /> {formatDate(lead.nextFollowUp)}</time>
              : <p>Sin fecha agendada</p>}
          </div>
          <button type="button" className="lead-panel-button lead-panel-secondary" onClick={() => onEdit("followup")} disabled={!!busy}>
            {lead.nextFollowUp ? "Reprogramar" : "Agendar"}
          </button>
        </section>

        <section className="lead-panel-activity" aria-label="Actividad del contacto">
          <h3>Actividad</h3>
          <form className="lead-panel-compose" onSubmit={saveActivity} aria-busy={busy === "activity" || undefined}>
            <div className="lead-panel-compose-controls">
              <label className="lead-panel-sr-only" htmlFor={kindId}>Tipo de actividad</label>
              <SelectField id={kindId} value={kind} onChange={(event) => setKind(event.target.value as ActivityInput["kind"])} disabled={!!busy}>
                {activityKinds.map((key) => <option key={key} value={key}>{activityOptions[key].label}</option>)}
              </SelectField>
              {messages && (
                <>
                  <label className="lead-panel-sr-only" htmlFor={directionId}>Dirección del mensaje</label>
                  <SelectField id={directionId} value={direction} onChange={(event) => setDirection(event.target.value as "sent" | "received")} disabled={!!busy}>
                    <option value="sent">Enviado</option>
                    <option value="received">Recibido</option>
                  </SelectField>
                </>
              )}
            </div>
            <label className="lead-panel-sr-only" htmlFor={bodyId}>Contenido de la actividad</label>
            <textarea id={bodyId} value={body} onChange={(event) => setBody(event.target.value)} placeholder={activityOptions[kind].placeholder} maxLength={4000} required disabled={!!busy} rows={3} />
            {activityError && <p className="lead-panel-alert" role="alert">{activityError}</p>}
            <button type="submit" className="lead-panel-button lead-panel-primary" disabled={!!busy || !body.trim()}>
              <Send size={15} aria-hidden="true" /> {busy === "activity" ? "Registrando…" : "Registrar actividad"}
            </button>
          </form>
          {sortedActivities.length ? (
            <ol className="lead-panel-timeline">
              {sortedActivities.map((activity) => <ActivityEntry key={activity.id} activity={activity} />)}
            </ol>
          ) : (
            <p className="lead-panel-empty">Todavía no hay actividad registrada.</p>
          )}
        </section>
      </div>
    </Panel>
  );
}
