import { randomUUID } from "node:crypto";
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
import { getStore } from "./store";

const stageNames = new Map(STAGES.map((stage) => [stage.id, stage.label]));

const contactFields = {
  name: { label: "Nombre", max: 120 },
  company: { label: "Empresa", max: 120 },
  role: { label: "Cargo", max: 100 },
  phone: { label: "Teléfono", max: 60 },
  email: { label: "Correo", max: 254 },
  source: { label: "Origen", max: 100 },
  nextAction: { label: "Próxima acción", max: 500 },
};
const textFields = Object.keys(contactFields) as Array<keyof typeof contactFields>;
const manualActivityKinds = new Set<ActivityInput["kind"]>(["note", "whatsapp", "call", "meeting", "email"]);

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
  return trimmed;
}

function readDate(value: unknown) {
  if (value === null || value === "") return null;

  const iso = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
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
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(fields.email)) {
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

function scope(user: CrmUser) {
  return user.role === "manager" ? null : user.id;
}

export async function listLeads(user: CrmUser) {
  return (await getStore()).list(scope(user));
}

export async function getLead(id: string, user: CrmUser) {
  const lead = await (await getStore()).get(id, scope(user));
  if (!lead) throw new RequestError(404, "El contacto no está disponible.");
  return lead;
}

export async function createLead(body: Record<string, unknown>, user: CrmUser, key?: string) {
  const fields = readInput(body, user, true);
  const now = new Date().toISOString();
  const stage = fields.stage ?? defaultLead.stage;
  const lead: Lead = {
    ...defaultLead,
    ...fields,
    assignee: fields.assignee ?? user.id,
    id: key ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
    wonAt: stage === "won" ? now : null,
    revision: 1,
    activities: [{
      id: randomUUID(),
      kind: "created",
      body: `Contacto creado en ${stageNames.get(stage)}.`,
      author: user.id,
      createdAt: now,
    }],
  };

  const store = await getStore();
  if (await store.insert(lead)) return lead;

  const existing = key ? await store.get(key, scope(user)) : undefined;
  if (!existing) throw new RequestError(409, "No se pudo crear el contacto. Intenta de nuevo.");
  return existing;
}

async function applyUpdate(
  id: string, user: CrmUser, expectedRevision: number | undefined, change: (lead: Lead) => Lead,
) {
  const store = await getStore();
  const assignee = scope(user);
  for (let attempt = 0; attempt < 5; attempt++) {
    const lead = await store.get(id, assignee);
    if (!lead) throw new RequestError(404, "El contacto no está disponible.");
    if (expectedRevision !== undefined && expectedRevision !== lead.revision) {
      throw new RequestError(409, "El contacto cambió en otra sesión. Actualiza la información e intenta de nuevo.");
    }

    const changed = change(lead);
    if (changed === lead) return lead;
    const updated = { ...changed, revision: lead.revision + 1 };
    if (await store.update(updated, lead.revision, assignee)) return updated;
  }
  throw new RequestError(409, "El contacto está cambiando en otra sesión. Intenta de nuevo.");
}

export async function updateLead(id: string, body: Record<string, unknown>, user: CrmUser) {
  const fields = readInput(body, user);
  if (Object.keys(fields).length === 0) throw new RequestError(400, "Indica qué datos deseas actualizar.");

  return applyUpdate(id, user, readRevision(body), (lead) => {
    const stage = fields.stage ?? lead.stage;
    const stageChanged = stage !== lead.stage;
    const fieldChanged = (Object.keys(fields) as Array<keyof LeadInput>).some(
      (field) => JSON.stringify(fields[field]) !== JSON.stringify(lead[field]),
    );
    if (!fieldChanged) return lead;

    const now = new Date().toISOString();
    return {
      ...lead,
      ...fields,
      updatedAt: now,
      wonAt: stage === "won" ? lead.wonAt ?? now : null,
      activities: stageChanged ? [stageActivity(lead, stage, user.id, now), ...lead.activities] : lead.activities,
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

  return applyUpdate(id, user, readRevision(body), (lead) => {
    if (lead.activities.some((entry) => entry.id === activity.id)) return lead;
    return {
      ...lead,
      updatedAt: new Date().toISOString(),
      activities: [activity, ...lead.activities],
    };
  });
}

export async function deleteLead(id: string, user: CrmUser) {
  if (!(await (await getStore()).remove(id, scope(user)))) {
    throw new RequestError(404, "El contacto no está disponible.");
  }
}
