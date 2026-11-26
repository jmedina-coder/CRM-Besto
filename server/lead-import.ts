import { parse } from "csv-parse/sync";
import readExcelFile, { type SheetData } from "read-excel-file/node";
import { fromBufferPromise } from "yauzl";
import { SALES_USERS, type CrmUser, type LeadImportReport, type SalesUserId } from "../app/model";
import { RequestError } from "./http";
import { importedLead } from "./leads";
import { getStore, type StoredLead } from "./store";

const maxExpandedBytes = 24 * 1024 * 1024;
const maxRows = 30_000;
const aliases = {
  code: ["codigo", "id", "codigo de contacto"],
  name: ["nombre de la persona", "nombre completo", "nombre del contacto", "nombre", "contacto"],
  company: ["nombre del establecimiento", "establecimiento", "empresa", "negocio", "razon social"],
  phone: ["telefono", "telefono o whatsapp", "celular", "movil", "whatsapp"],
  email: ["correo", "correo electronico", "email", "e mail"],
  activity: ["actividad", "actividad economica", "sector", "giro"],
  assignee: ["responsable", "encargado", "asignado a", "usuario"],
};
type Field = keyof typeof aliases;
type Sheet = { name: string; data: SheetData };

function key(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function text(value: unknown) {
  return (value === null || value === undefined ? "" : String(value)).trim();
}

function header(data: SheetData) {
  for (const [index, row] of data.slice(0, 20).entries()) {
    const titles = row.map((cell) => key(text(cell)));
    const columns = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [
      field, titles.findIndex((title) => names.includes(title)),
    ])) as Record<Field, number>;
    if (columns.name >= 0 || columns.company >= 0 ||
        (columns.code >= 0 && (columns.phone >= 0 || columns.email >= 0))) {
      return { index, columns };
    }
  }
  return null;
}

async function readWorkbook(bytes: Buffer): Promise<Sheet[]> {
  const zip = await fromBufferPromise(bytes);
  try {
    if (zip.entryCount > 256) throw new RequestError(413, "El libro contiene demasiados componentes.");
    let expanded = 0;
    const entries = new Set<string>();
    for await (const entry of zip.eachEntry()) {
      expanded += entry.uncompressedSize;
      if (expanded > maxExpandedBytes) throw new RequestError(413, "El libro Excel es demasiado grande al abrirlo.");
      if (entries.has(entry.fileName)) throw new RequestError(400, "El libro Excel contiene componentes repetidos.");
      entries.add(entry.fileName);
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      for await (const _ of stream) {
        // Validate the declared ZIP entry size before loading the workbook.
      }
    }
  } finally {
    zip.close();
  }
  const sheets = await readExcelFile(bytes);
  return sheets.map(({ sheet, data }) => ({ name: sheet, data }));
}

function readCsv(bytes: Buffer): Sheet[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (const delimiter of [",", ";", "\t"]) {
    try {
      const data: SheetData = parse(source, { delimiter, max_record_size: 8192, relax_column_count: true });
      if (header(data)) return [{ name: "CSV", data }];
    } catch {
      // Another delimiter may be the one used by this file.
    }
  }
  throw new RequestError(400, "El CSV no tiene columnas reconocibles. Usa un archivo UTF-8 con Nombre, Empresa o Código y datos de contacto.");
}

export async function importContacts(bytes: Buffer, format: "xlsx" | "csv", actor: CrmUser, defaultAssignee: SalesUserId, confirm: boolean) {
  let sheets: Sheet[];
  try {
    sheets = format === "xlsx" ? await readWorkbook(bytes) : readCsv(bytes);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "No se pudo leer el archivo. Revisa que sea un Excel .xlsx o un CSV UTF-8 válido.");
  }

  const report: LeadImportReport = {
    rows: 0, sheets: [], ignoredSheets: [], namesCompleted: 0, unverifiedEmails: 0,
    assigned: { jhon: 0, pelos: 0, alejandra: 0 },
  };
  const leads: StoredLead[] = [];
  const now = new Date().toISOString();
  const users = new Map(SALES_USERS.flatMap((user) => [[key(user.name), user.id], [key(user.id), user.id]]));
  for (const sheet of sheets) {
    const first = header(sheet.data);
    if (!first) {
      if (sheet.data.some((row) => row.some((cell) => text(cell)))) report.ignoredSheets.push(sheet.name);
      continue;
    }
    let rows = 0;
    for (const [offset, row] of sheet.data.slice(first.index + 1).entries()) {
      const value = (field: Field) => text(row[first.columns[field]]);
      const code = value("code");
      const person = value("name");
      const company = value("company");
      const phone = value("phone");
      const email = value("email");
      const activity = value("activity");
      const assignedTo = value("assignee");
      if (![code, person, company, phone, email, activity, assignedTo].some(Boolean)) continue;
      if (leads.length === maxRows) throw new RequestError(413, `Importa hasta ${maxRows.toLocaleString("es-CO")} contactos por archivo.`);
      try {
        const assignee = assignedTo ? users.get(key(assignedTo)) : defaultAssignee;
        if (!assignee) throw new RequestError(400, "El responsable debe ser un usuario del CRM.");
        if (!person && !company && !code && !phone && !email) {
          throw new RequestError(400, "Agrega un nombre, un código o un dato de contacto.");
        }
        if ([code, activity, email, sheet.name].some((field) => field.includes("\u0000") || !field.isWellFormed())) {
          throw new RequestError(400, "La fila contiene caracteres no válidos.");
        }
        if (code.length > 120 || activity.length > 2000 || email.length > 254) {
          throw new RequestError(400, "Revisa la longitud del código, la actividad o el correo.");
        }
        const name = person || company || `Contacto ${code || phone || email}`;
        const lead = importedLead({ name, company, phone, email, assignee }, {
          code, sheet: sheet.name, activity, ...(!person ? { fallbackName: true } : {}),
        }, actor, now);
        leads.push(lead);
        rows++;
        report.assigned[assignee]++;
        if (lead.imported?.fallbackName) report.namesCompleted++;
        if (lead.imported?.unverifiedEmail) report.unverifiedEmails++;
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        throw new RequestError(error.status, `Hoja ${sheet.name}, fila ${first.index + offset + 2}. ${error.message}`);
      }
    }
    report.sheets.push({ name: sheet.name, rows });
  }
  if (!leads.length) throw new RequestError(400, "No encontramos filas de contactos. Revisa los encabezados del archivo.");
  report.rows = leads.length;
  if (confirm) {
    report.created = await (await getStore()).insertMany(leads);
    report.skipped = report.rows - report.created;
  }
  return report;
}
