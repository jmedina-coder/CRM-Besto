import { createHash, randomUUID } from "node:crypto";
import {
  SALES_USERS,
  STAGES,
  type Activity,
  type ActivityInput,
  type CrmUser,
  type Lead,
  type LeadInput,
  type SalesUserId,
  type Stage,
} from "../app/model";
import { RequestError } from "./http";
import { getStore, type StoredLead } from "./store";

const stageNames = new Map(STAGES.map((stage) => [stage.id, stage.label]));
const salesNames = new Map(SALES_USERS.map((user) => [user.id, user.name]));

const contactFields = {
  name: { label: "Nombre", max: 254 },
  company: { label: "Empresa", max: 254 },
  role: { label: "Cargo", max: 100 },
  phone: { label: "Teléfono", max: 60 },
  email: { label: "Correo", max: 254 },
  source: { label: "Origen", max: 100 },
  nextAction: { label: "Próxima acción", max: 500 },
};
const textFields = Object.keys(contactFields) as Array<keyof typeof contactFields>;
const fieldLabels: Partial<Record<keyof LeadInput, string>> = {
  ...Object.fromEntries(textFields.map((field) => [field, contactFields[field].label])),
  tags: "Etiquetas",
  amount: "Valor comercial",
  nextFollowUp: "Fecha de seguimiento",
};
const manualActivityKinds = new Set<ActivityInput["kind"]>(["note", "whatsapp", "call", "meeting", "email"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const defaultLead: Omit<LeadInput, "assignee"> = {
  name: "",
  company: "",
  role: "",
  phone: "",
  email: "",
  source: "",
  tags: [],
  amount: null,
  stage: "new",
  nextFollowUp: null,
  nextAction: "",
};

function readText(value: unknown, label: string, max: number, required = false) {
  if (typeof value !== "string") {
    throw new RequestError(400, `${label} debe ser texto.`);
  }

  const trimmed = value.trim();
  if (!trimmed && required) throw new RequestError(400, `${label} es obligatorio.`);
  if (trimmed.length > max) throw new RequestError(400, `${label} admite hasta ${max} caracteres.`);
  if (trimmed.includes("\u0000") || !trimmed.isWellFormed()) {
    throw new RequestError(400, `${label} contiene caracteres no válidos.`);
  }
  return trimmed;
}

function readDate(value: unknown) {
  if (value === null || value === "") return null;

  const iso = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!iso) throw new RequestError(400, "Elige una fecha y hora de seguimiento válidas.");

  const [, year, month, day] = iso.map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timestamp = Date.parse(value as string);
  if (
    !Number.isFinite(timestamp) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  ) {
    throw new RequestError(400, "Elige una fecha y hora de seguimiento válidas.");
  }
  return new Date(timestamp).toISOString();
}

function readTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new RequestError(400, "Puedes guardar hasta 20 etiquetas.");
  }
  const tags = new Map<string, string>();
  for (const item of value) {
    const tag = readText(item, "La etiqueta", 30);
    const key = tag.toLocaleLowerCase("es-CO");
    if (tag && !tags.has(key)) tags.set(key, tag);
  }
  return [...tags.values()];
}

function readInput(body: Record<string, unknown>, user: CrmUser, creating = false) {
  const fields: Partial<LeadInput> = {};
  for (const field of textFields) {
    if (!Object.hasOwn(body, field)) continue;
    const { label, max } = contactFields[field];
    fields[field] = readText(body[field], label, max, field === "name");
  }

  if (creating && !fields.name) throw new RequestError(400, "El nombre es obligatorio.");
  if (fields.email && !emailPattern.test(fields.email)) {
    throw new RequestError(400, "Escribe un correo válido.");
  }

  if (Object.hasOwn(body, "tags")) fields.tags = readTags(body.tags);
  if (Object.hasOwn(body, "nextFollowUp")) fields.nextFollowUp = readDate(body.nextFollowUp);
  if (Object.hasOwn(body, "stage")) {
    if (typeof body.stage !== "string" || !stageNames.has(body.stage as Stage)) {
      throw new RequestError(400, "Elige una etapa válida.");
    }
    fields.stage = body.stage as Stage;
  }

  if (Object.hasOwn(body, "assignee")) {
    const assignee = SALES_USERS.find((seller) => seller.id === body.assignee);
    if (!assignee) throw new RequestError(400, "Elige un responsable válido.");
    if (user.role !== "manager" && assignee.id !== user.id) {
      throw new RequestError(403, "Tu cuenta solo puede gestionar sus propios contactos.");
    }
    fields.assignee = assignee.id;
  }

  if (Object.hasOwn(body, "amount")) {
    const amount = body.amount;
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e12)) {
      throw new RequestError(400, "El valor comercial debe estar entre 0 y un billón de pesos.");
    }
    fields.amount = amount;
  }
  return fields;
}

function readRevision(body: Record<string, unknown>) {
  if (!Object.hasOwn(body, "revision")) return undefined;
  const revision = body.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new RequestError(400, "La revisión del contacto es inválida.");
  }
  return revision;
}

function stageActivity(previous: Lead, stage: Stage, author: SalesUserId, now: string): Activity {
  return {
    id: randomUUID(),
    kind: "stage",
    body: `${stageNames.get(previous.stage)} → ${stageNames.get(stage)}`,
    author,
    createdAt: now,
  };
}

function editActivity(lead: Lead, fields: Partial<LeadInput>, changed: Array<keyof LeadInput>, author: SalesUserId, now: string): Activity | null {
  const details = [];
  if (fields.assignee && changed.includes("assignee")) {
    details.push(`Responsable: ${salesNames.get(lead.assignee) ?? lead.assignee} → ${salesNames.get(fields.assignee)}.`);
  }
  const editedFields = changed.map((field) => fieldLabels[field]).filter(Boolean);
  if (editedFields.length) details.push(`Campos editados: ${editedFields.join(", ")}.`);
  if (!details.length) return null;
  return { id: randomUUID(), kind: "updated", body: details.join(" "), author, createdAt: now };
}

function publicLead({ creationFingerprint: _, ...lead }: StoredLead): Lead {
  return lead;
}

function scope(user: CrmUser) {
  return user.role === "manager" ? null : user.id;
}

export async function listLeads(user: CrmUser) {
  const store = await getStore();
  return (await store.list(scope(user))).map(publicLead);
}

export async function listLeadPage(user: CrmUser, after: string) {
  const size = 500;
  const store = await getStore();
  const rows = await store.listPage(scope(user), after, size + 1);
  const leads = rows.slice(0, size).map(publicLead);
  return { leads, nextCursor: rows.length > size ? leads[size - 1].id : null };
}

export async function getLead(id: string, user: CrmUser) {
  const lead = await (await getStore()).get(id, scope(user));
  if (!lead) throw new RequestError(404, "El contacto no está disponible.");
  return publicLead(lead);
}

function readLeadDraft(body: Record<string, unknown>, user: CrmUser): LeadInput {
  const fields = readInput(body, user, true);
  return {
    ...defaultLead,
    ...fields,
    assignee: fields.assignee ?? user.id,
  };
}

function newLead(input: LeadInput, user: CrmUser, id: string, now: string, imported?: Lead["imported"]): Lead {
  return {
    ...input,
    ...(imported ? { imported } : {}),
    id,
    createdAt: now,
    updatedAt: now,
    wonAt: input.stage === "won" ? now : null,
    revision: 1,
    activities: [{
      id: randomUUID(),
      kind: "created",
      body: imported ? `Contacto importado de la hoja ${imported.sheet}.` : `Contacto creado en ${stageNames.get(input.stage)}.`,
      author: user.id,
      createdAt: now,
    }],
  };
}

export function importedLead(
  draft: { name: string; company: string; phone: string; email: string; assignee: SalesUserId },
  details: NonNullable<Lead["imported"]>,
  user: CrmUser,
  now: string,
) {
  const email = draft.email && !emailPattern.test(draft.email) ? { unverifiedEmail: draft.email } : {};
  const input = readLeadDraft({
    ...draft,
    ...("unverifiedEmail" in email ? { email: "" } : {}),
    source: "Importación de contactos",
    tags: [details.sheet],
  }, user);
  const hash = createHash("sha256").update(JSON.stringify([
    details.code, draft.name, draft.company, draft.phone, draft.email, details.activity,
  ])).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return newLead(input, user, id, now, { ...details, ...email });
}

export async function createLead(body: Record<string, unknown>, user: CrmUser, key?: string) {
  const input = readLeadDraft(body, user);
  const lead: StoredLead = newLead(input, user, key ?? randomUUID(), new Date().toISOString());
  if (key) lead.creationFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const store = await getStore();
  if (await store.insert(lead)) return publicLead(lead);

  const existing = key ? await store.get(key, scope(user)) : undefined;
  if (!existing) throw new RequestError(409, "No se pudo crear el contacto. Intenta de nuevo.");
  const creator = existing.activities.find((entry) => entry.kind === "created")?.author;
  // Earlier records used the request key as their ID without retaining the original fields.
  const sameInput = existing.creationFingerprint === undefined
    ? (Object.keys(input) as Array<keyof LeadInput>).every(
      (field) => JSON.stringify(input[field]) === JSON.stringify(existing[field]),
    )
    : existing.creationFingerprint === lead.creationFingerprint;
  if (creator !== user.id || !sameInput) {
    throw new RequestError(409, "Esta clave de guardado ya se usó para otro contacto.");
  }
  return publicLead(existing);
}

async function applyUpdate(
  id: string,
  user: CrmUser,
  expectedRevision: number | undefined,
  change: (lead: StoredLead) => StoredLead,
  isReplay?: (lead: StoredLead) => boolean,
) {
  const store = await getStore();
  const assignee = scope(user);
  for (let attempt = 0; attempt < 5; attempt++) {
    const lead = await store.get(id, assignee);
    if (!lead) throw new RequestError(404, "El contacto no está disponible.");
    if (isReplay?.(lead)) return publicLead(lead);
    if (expectedRevision !== undefined && expectedRevision !== lead.revision) {
      throw new RequestError(409, "El contacto cambió en otra sesión. Actualiza la información e intenta de nuevo.");
    }

    const changed = change(lead);
    if (changed === lead) return publicLead(lead);
    const updated = { ...changed, revision: lead.revision + 1 };
    if (await store.update(updated, lead.revision, assignee)) return publicLead(updated);
  }
  throw new RequestError(409, "El contacto está cambiando en otra sesión. Intenta de nuevo.");
}

export async function updateLead(id: string, body: Record<string, unknown>, user: CrmUser) {
  const fields = readInput(body, user);
  if (Object.keys(fields).length === 0) throw new RequestError(400, "Indica qué datos deseas actualizar.");

  return applyUpdate(id, user, readRevision(body), (lead) => {
    const stage = fields.stage ?? lead.stage;
    const changed = (Object.keys(fields) as Array<keyof LeadInput>).filter(
      (field) => JSON.stringify(fields[field]) !== JSON.stringify(lead[field]),
    );
    if (!changed.length) return lead;

    const now = new Date().toISOString();
    const edits = editActivity(lead, fields, changed, user.id, now);
    return {
      ...lead,
      ...fields,
      updatedAt: now,
      wonAt: stage === "won" ? lead.wonAt ?? now : null,
      activities: [
        ...(stage !== lead.stage ? [stageActivity(lead, stage, user.id, now)] : []),
        ...(edits ? [edits] : []),
        ...lead.activities,
      ],
    };
  });
}

export async function addActivity(id: string, body: Record<string, unknown>, user: CrmUser, key?: string) {
  if (!manualActivityKinds.has(body.kind as ActivityInput["kind"])) {
    throw new RequestError(400, "Elige un tipo de actividad válido.");
  }
  const direction = body.direction;
  if (direction !== undefined && direction !== "sent" && direction !== "received") {
    throw new RequestError(400, "La dirección de la actividad es inválida.");
  }

  const now = new Date().toISOString();
  const activity: Activity = {
    id: key ?? randomUUID(),
    kind: body.kind as ActivityInput["kind"],
    body: readText(body.body, "El detalle de la actividad", 4_000, true),
    author: user.id,
    createdAt: now,
    ...(direction ? { direction } : {}),
  };

  return applyUpdate(id, user, readRevision(body), (lead) => ({
    ...lead,
    updatedAt: new Date().toISOString(),
    activities: [activity, ...lead.activities],
  }), key ? (lead) => {
    const existing = lead.activities.find((entry) => entry.id === key);
    if (!existing) return false;
    if (
      existing.author !== user.id || existing.kind !== activity.kind ||
      existing.body !== activity.body || existing.direction !== activity.direction
    ) {
      throw new RequestError(409, "Esta clave de guardado ya se usó para otra actividad.");
    }
    return true;
  } : undefined);
}

export async function deleteLead(id: string, user: CrmUser) {
  if (!(await (await getStore()).remove(id, scope(user)))) {
    throw new RequestError(404, "El contacto no está disponible.");
  }
}
