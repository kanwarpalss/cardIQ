import { NextResponse } from "next/server";
import { parseOrderUpload, type OrderUploadSource } from "@/lib/imports/order-upload";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ORDERS = 10_000;
const UPSERT_BATCH = 500;

function isUploadSource(value: FormDataEntryValue | null): value is OrderUploadSource {
  return value === "amazon" || value === "blinkit";
}

/** POST /api/orders/import — import an Amazon CSV or a Blinkit JSON capture.
 * Files stay in memory, authenticated through the regular Supabase session,
 * and use stable synthetic IDs: uploading the same export updates its rows. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_upload", message: "Couldn't read that upload. Choose the original export file and try again." }, { status: 400 });
  }
  const sourceValue = form.get("source");
  if (!isUploadSource(sourceValue)) {
    return NextResponse.json({ error: "invalid_source", message: "Choose either an Amazon CSV or a Blinkit JSON export." }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "missing_file", message: "Choose an export file first." }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "invalid_file_size", message: "Use a non-empty export smaller than 10 MB." }, { status: 400 });
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "invalid_encoding", message: "This export must be a UTF-8 CSV or JSON file." }, { status: 400 });
  }
  let orders;
  try {
    orders = parseOrderUpload(sourceValue, contents);
  } catch (error) {
    return NextResponse.json({ error: "invalid_export", message: error instanceof Error ? error.message : "This isn't a recognised order export." }, { status: 400 });
  }
  if (orders.length === 0) {
    return NextResponse.json({ error: "empty_export", message: sourceValue === "amazon"
      ? "No Amazon orders were found. Choose the Order History CSV inside Amazon's export."
      : "No Blinkit orders were found. Choose the JSON captured from your Blinkit order history." }, { status: 400 });
  }
  if (orders.length > MAX_ORDERS) {
    return NextResponse.json({ error: "too_many_orders", message: "That export has too many orders to import safely. Please split it into smaller files." }, { status: 400 });
  }

  const prefix = sourceValue === "amazon" ? "amazon-csv" : "blinkit-json";
  const rows = orders.map((order) => ({
    user_id: user.id, source: sourceValue, kind: "order",
    gmail_message_id: `${prefix}:${order.orderRef}`,
    order_ref: order.orderRef, merchant_name: order.merchant,
    total_amount: order.total, order_at: order.orderedAt, items: order.items,
    raw_subject: `${sourceValue === "amazon" ? "Amazon" : "Blinkit"} export ${order.orderRef}`,
    // Deliberately omit review/payment/link columns. An updated export must
    // never erase a match or payment decision already reviewed by KP.
  }));
  for (let index = 0; index < rows.length; index += UPSERT_BATCH) {
    const { error } = await supabase.from("orders")
      .upsert(rows.slice(index, index + UPSERT_BATCH), { onConflict: "user_id,gmail_message_id" });
    if (error) return NextResponse.json({ error: "import_failed", message: `Couldn't save the export: ${error.message}` }, { status: 500 });
  }

  // The official Amazon export replaces the old amount-less Delivered rows.
  // Refund evidence stays intact because it has kind='refund'.
  let removedDeliveredEmails = 0;
  if (sourceValue === "amazon") {
    const { data, error } = await supabase.from("orders").delete()
      .eq("user_id", user.id).eq("source", "amazon").eq("kind", "order")
      .not("gmail_message_id", "like", "amazon-csv:%").select("id");
    if (error) return NextResponse.json({ error: "cleanup_failed", message: `Orders imported, but old Amazon delivery emails couldn't be cleared: ${error.message}` }, { status: 500 });
    removedDeliveredEmails = data?.length ?? 0;
  }
  return NextResponse.json({ imported: rows.length, removedDeliveredEmails });
}
