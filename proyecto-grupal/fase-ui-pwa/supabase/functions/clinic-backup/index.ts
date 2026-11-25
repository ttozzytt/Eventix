import { createClient } from "npm:@supabase/supabase-js@2.119.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readTable(admin: ReturnType<typeof createClient>, table: string) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin.from(table).select("*").range(offset, offset + pageSize - 1);
    if (error) throw new Error("No se pudo leer la tabla " + table);
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > 10000) throw new Error("La tabla " + table + " supera el límite de 10.000 filas por archivo.");
    if (page.length < pageSize) break;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.match(/^Bearer\\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Se requiere una sesión iniciada." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "El servicio de respaldo no está configurado." }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "La sesión no es válida." }, 401);
  if (authData.user.app_metadata?.role !== "staff") {
    return json({ error: "Solo el personal autorizado puede gestionar respaldos." }, 403);
  }

  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 5 * 1024 * 1024) {
      return json({ error: "El archivo supera el límite de 5 MB." }, 413);
    }
    const payload = JSON.parse(rawBody);
    if (payload?.action === "export") {
      const names = ["profiles","pets","appointment_requests","pet_medical_records","services_catalog","clinic_activity_log"];
      const tables: Record<string, unknown[]> = {};
      for (const name of names) tables[name] = await readTable(admin,name);

      const exportedAt = new Date().toISOString();
      const watermark = {
        generated_at: exportedAt,
        sha256: await sha256(JSON.stringify({ version: 1, tables }))
      };
      const backup = {
        format: "pata-andina-backup",
        version: 1,
        project: "pata-andina",
        backup_id: crypto.randomUUID(),
        exported_at: exportedAt,
        control_array: names.map(table => ({ table, rows: tables[table].length })),
        watermark,
        tables
      };
      const serialized = JSON.stringify(backup,null,2);
      if (new TextEncoder().encode(serialized).byteLength > 5 * 1024 * 1024) {
        return json({ error: "El respaldo supera el límite de 5 MB." },413);
      }
      return new Response(serialized,{headers:corsHeaders});
    }

    if (payload?.action === "restore") {
      const backup = payload.backup;
      const names = ["profiles","pets","appointment_requests","pet_medical_records","services_catalog","clinic_activity_log"];
      if (!backup || backup.format !== "pata-andina-backup" || backup.version !== 1 ||
          backup.project !== "pata-andina" || !backup.tables || typeof backup.tables !== "object" ||
          Array.isArray(backup.tables) || !backup.watermark || typeof backup.watermark.sha256 !== "string" ||
          !Array.isArray(backup.control_array)) {
        return json({ error: "El archivo no corresponde a un respaldo válido de Pata Andina." },400);
      }
      for (const name of names) {
        const rows = backup.tables[name];
        if (!Array.isArray(rows) || rows.length > 10000) return json({ error: "La sección " + name + " no es válida." },400);
      }
      const control = names.map(table => ({ table, rows: backup.tables[table].length }));
      if (JSON.stringify(control) !== JSON.stringify(backup.control_array)) {
        return json({ error: "El arreglo de control no coincide con el contenido del respaldo." },400);
      }
      const expectedHash = await sha256(JSON.stringify({ version: 1, tables: backup.tables }));
      if (expectedHash !== backup.watermark.sha256) {
        return json({ error: "La huella de integridad no coincide. El archivo pudo modificarse o dañarse." },400);
      }
      const { data, error } = await admin.rpc("restore_clinic_backup",{p_backup:backup});
      if (error) return json({ error: "No se pudo restaurar el archivo. Verifica que pertenezca a esta versión de Pata Andina." },400);
      return json({ ok:true, result:data });
    }
    return json({ error: "Acción no reconocida." },400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado.";
    return json({ error:message },400);
  }
});
