// main.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { callGPT4 } from "./callChatGPT4.ts"; // Import the GPT-4 caller
import log from "./log.ts"; // Import the timestamped logger

// --- Configuration Loading ---
// Load environment variables from .env file
// Ensure this runs before accessing environment variables
const env = await load({ export: true }); // Loads into Deno.env directly

const HAPPY_SCRIBE_API_KEY = Deno.env.get("HAPPY_SCRIBE_API_KEY");
const ZOHO_CLIENT_ID = Deno.env.get("ZOHO_CLIENT_ID");
const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET");
const ZOHO_REFRESH_TOKEN = Deno.env.get("ZOHO_REFRESH_TOKEN");
const ZOHO_API_DOMAIN = Deno.env.get("ZOHO_API_DOMAIN") || "https://www.zohoapis.com";
const ZOHO_ACCOUNTS_URL = Deno.env.get("ZOHO_ACCOUNTS_URL") || "https://accounts.zoho.com";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY"); // Load OpenAI Key
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

// Basic validation
// --- IMPORTANT: ZOHO_REFRESH_TOKEN is still needed for Zoho integration to work! ---
if (!HAPPY_SCRIBE_API_KEY || !ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !OPENAI_API_KEY) {
    log("ERROR: Missing required environment variables! Check HAPPY_SCRIBE_API_KEY, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, OPENAI_API_KEY.");
    Deno.exit(1); // Exit if critical env vars are missing
} else {
    log("Environment variables loaded successfully.");
}

// --- Instantiate GPT Caller ---
const gptCaller = callGPT4(OPENAI_API_KEY);

// --- Zoho API Helpers ---

// In-memory store for the access token (improve with a persistent store if needed)
let zohoAccessToken: string | null = null;
let tokenExpiryTime: number | null = null;

async function getZohoAccessToken(): Promise<string> {
    const functionName = "getZohoAccessToken";
    // Check if the current token is valid (with a small buffer)
    if (zohoAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime - 60000) { // 60s buffer
        log(`[${functionName}] Using cached Zoho access token.`);
        return zohoAccessToken;
    }

    log(`[${functionName}] Refreshing Zoho access token...`);
    const tokenUrl = `${ZOHO_ACCOUNTS_URL}/oauth/v2/token`;
    const params = new URLSearchParams();
    params.append("client_id", ZOHO_CLIENT_ID!);
    params.append("client_secret", ZOHO_CLIENT_SECRET!);
    params.append("refresh_token", ZOHO_REFRESH_TOKEN!);
    params.append("grant_type", "refresh_token");

    try {
        const response = await fetch(tokenUrl, {
            method: "POST",
            body: params,
        });

        if (!response.ok) {
            const errorText = await response.text();
            log(`[${functionName}] ERROR: Failed to refresh Zoho token - Status ${response.status}`, errorText);
            throw new Error(`Failed to refresh Zoho token: ${response.status} ${errorText}`);
        }

        const tokenData = await response.json();
        log(`[${functionName}] Token refresh response received:`, JSON.stringify(tokenData)); // Log the raw response

        if (tokenData.error) {
             log(`[${functionName}] ERROR: Zoho token refresh API returned error:`, tokenData.error);
             throw new Error(`Zoho token refresh error: ${tokenData.error}`);
        }

        if (!tokenData.access_token) {
            log(`[${functionName}] ERROR: Access token not found in Zoho response.`);
            throw new Error("Access token not found in Zoho token refresh response.");
        }

        zohoAccessToken = tokenData.access_token;
        // Zoho typically gives expiry in seconds
        tokenExpiryTime = Date.now() + (tokenData.expires_in * 1000);
        log(`[${functionName}] Successfully refreshed Zoho access token. Expires around: ${new Date(tokenExpiryTime).toISOString()}`);
        return zohoAccessToken!;

    } catch (error) {
        log(`[${functionName}] CATCH ERROR refreshing Zoho token:`, error instanceof Error ? error.message : String(error), error);
        // Clear potentially bad token state
        zohoAccessToken = null;
        tokenExpiryTime = null;
        throw error; // Re-throw to indicate failure
    }
}

// --- Function to find Lead ID by email or phone ---
async function findZohoLeadId(email: string | null, phone: string | null): Promise<string | null> {
    const functionName = "findZohoLeadId";
    if (!email && !phone) {
        log(`[${functionName}] Cannot search for lead without email or phone.`);
        return null;
    }

    let criteria = "";
    if (email) {
        criteria = `(Email:equals:${email})`;
        log(`[${functionName}] Searching for Lead using criteria: ${criteria}`);
    } else if (phone) {
        // Basic phone number cleanup (remove common non-digits) - might need refinement
        const cleanedPhone = phone.replace(/[\s+\-().]/g, '');
        criteria = `(Phone:equals:${cleanedPhone})`; // Assumes Zoho stores phone similarly
        log(`[${functionName}] Searching for Lead using criteria: ${criteria}`);
    }

    const searchUrl = `${ZOHO_API_DOMAIN}/crm/v2/Leads/search?criteria=${encodeURIComponent(criteria)}`;
    log(`[${functionName}] Search URL: ${searchUrl}`);

    let accessToken: string;
    try {
        accessToken = await getZohoAccessToken();
    } catch (tokenError) {
        log(`[${functionName}] ERROR: Failed to get access token for lead search.`, tokenError);
        return null; // Cannot search without token
    }

    try {
        log(`[${functionName}] Sending GET request to Zoho Lead Search API...`);
        const response = await fetch(searchUrl, {
            method: "GET",
            headers: {
                "Authorization": `Zoho-oauthtoken ${accessToken}`,
            },
        });

        const responseBodyText = await response.text();
        log(`[${functionName}] Zoho Lead Search API Response Status: ${response.status}`);
        log(`[${functionName}] Zoho Lead Search API Response Body:`, responseBodyText);

        if (!response.ok) {
            // Check for permission error specifically
            if (response.status === 403) {
                 log(`[${functionName}] WARNING: Received 403 Forbidden. This might indicate missing 'ZohoCRM.modules.leads.READ' scope for the refresh token.`);
            }
            log(`[${functionName}] ERROR: Zoho Lead Search API returned non-success status ${response.status}.`);
            return null; // Search failed
        }

        const responseData = JSON.parse(responseBodyText);

        if (responseData?.data?.length > 0) {
            const leadId = responseData.data[0].id;
            log(`[${functionName}] Found Lead ID: ${leadId}`);
            return leadId;
        } else {
            log(`[${functionName}] No matching Lead found for criteria: ${criteria}`);
            return null;
        }

    } catch (error) {
        log(`[${functionName}] CATCH ERROR during lead search:`, error instanceof Error ? error.message : String(error), error);
        return null;
    }
}


async function createZohoNote(title: string, content: string, leadId: string | null = null): Promise<void> {
    const functionName = "createZohoNote";
    log(`[${functionName}] Attempting to create note. Title: "${title}". Linking to Lead ID: ${leadId ?? 'None'}`);
    let accessToken: string;
    try {
        accessToken = await getZohoAccessToken(); // Will refresh if needed
    } catch (tokenError) {
        log(`[${functionName}] ERROR: Failed to get access token before creating note.`, tokenError);
        throw new Error("Failed to get Zoho access token for note creation.", { cause: tokenError });
    }

    const notesUrl = `${ZOHO_API_DOMAIN}/crm/v2/Notes`;
    log(`[${functionName}] Using Notes URL: ${notesUrl}`);

    const notePayload: any = { // Use 'any' for flexibility adding parent
        Note_Title: title,
        Note_Content: content,
    };

    // If a leadId is provided, add the linking information
    if (leadId) {
        notePayload.Parent_Id = { id: leadId };
        notePayload.$se_module = "Leads";
        log(`[${functionName}] Added Parent_Id (${leadId}) and $se_module (Leads) to note payload.`);
    } else {
        log(`[${functionName}] Creating note without linking to a parent record.`);
    }

    const noteData = {
        data: [notePayload],
        trigger: [
            // Optional triggers like workflows, if needed
        ],
    };
    log(`[${functionName}] Note data prepared:`, JSON.stringify(noteData));

    try {
        log(`[${functionName}] Sending POST request to Zoho Notes API...`);
        const response = await fetch(notesUrl, {
            method: "POST",
            headers: {
                "Authorization": `Zoho-oauthtoken ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(noteData),
        });

        const responseBodyText = await response.text(); // Read body as text first for better error logging
        log(`[${functionName}] Zoho API Response Status: ${response.status}`);
        log(`[${functionName}] Zoho API Response Body:`, responseBodyText);

        let responseData: any;
        try {
            responseData = JSON.parse(responseBodyText); // Now parse the text
        } catch (parseError) {
            log(`[${functionName}] ERROR: Failed to parse Zoho API response JSON. Status: ${response.status}`, parseError);
            throw new Error(`Failed to parse Zoho API response JSON (Status: ${response.status}): ${responseBodyText}`, { cause: parseError });
        }


        if (response.status > 299) { // Check for 2xx success codes
             log(`[${functionName}] ERROR: Zoho API returned non-success status ${response.status}. Response:`, responseData);
             throw new Error(`Failed to create Zoho note: Status ${response.status}. Response: ${JSON.stringify(responseData)}`);
        }

        log(`[${functionName}] Zoho Note creation API call successful.`);

        // Check the actual response structure from Zoho for success details
        if (responseData?.data?.[0]?.code === "SUCCESS") {
             const noteId = responseData.data[0].details.id;
             log(`[${functionName}] Successfully created Zoho Note with ID: ${noteId}`);
        } else {
             log(`[${functionName}] WARNING: Zoho Note creation status uncertain or failed in response data. Response:`, responseData);
             // Optionally throw an error here if a SUCCESS code is strictly required
             // throw new Error(`Zoho Note creation failed according to response data: ${JSON.stringify(responseData)}`);
        }

    } catch (error) {
        log(`[${functionName}] CATCH ERROR creating Zoho note:`, error instanceof Error ? error.message : String(error), error);
        throw error; // Propagate error
    }
}


// --- Happy Scribe API Helper ---
async function getHappyScribeTranscriptionText(transcriptionId: string): Promise<string> {
    const functionName = "getHappyScribeTranscriptionText";
    const url = `https://www.happyscribe.com/api/v1/transcriptions/${transcriptionId}/export?format=txt`;
    log(`[${functionName}] Fetching transcription text export URL for ID: ${transcriptionId}. URL: ${url}`);

    try {
        log(`[${functionName}] Sending GET request to Happy Scribe export endpoint...`);
        const response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${HAPPY_SCRIBE_API_KEY}`,
            },
        });

        const exportBodyText = await response.text(); // Read body as text first
        log(`[${functionName}] Happy Scribe Export URL Response Status: ${response.status}`);
        log(`[${functionName}] Happy Scribe Export URL Response Body:`, exportBodyText);

        if (!response.ok) {
            log(`[${functionName}] ERROR: Failed to fetch Happy Scribe export URL - Status ${response.status}`, exportBodyText);
            throw new Error(`Failed to fetch Happy Scribe export URL: ${response.status} ${exportBodyText}`);
        }

        let exportData: any;
         try {
            exportData = JSON.parse(exportBodyText);
        } catch (parseError) {
            log(`[${functionName}] ERROR: Failed to parse Happy Scribe export URL response JSON.`, parseError);
            throw new Error(`Failed to parse Happy Scribe export URL response JSON: ${exportBodyText}`, { cause: parseError });
        }


        if (!exportData?.export_url) {
            log(`[${functionName}] ERROR: Happy Scribe API did not return an export_url in the response.`, exportData);
            throw new Error("Happy Scribe API did not return an export URL.");
        }

        const exportUrl = exportData.export_url;
        log(`[${functionName}] Received export URL: ${exportUrl}. Fetching text content...`);

        // Fetch the actual text content from the export URL
        const textResponse = await fetch(exportUrl);
        const transcriptionText = await textResponse.text(); // Read text content
        log(`[${functionName}] Transcription Text Response Status: ${textResponse.status}`);


        if (!textResponse.ok) {
             log(`[${functionName}] ERROR: Failed to download transcription text from export URL ${exportUrl} - Status ${textResponse.status}`, transcriptionText);
             throw new Error(`Failed to download transcription text: ${textResponse.status}`);
        }


        log(`[${functionName}] Successfully fetched transcription text (length: ${transcriptionText.length})`);
        return transcriptionText;

    } catch (error) {
        log(`[${functionName}] CATCH ERROR fetching transcription text:`, error instanceof Error ? error.message : String(error), error);
        throw error;
    }
}


// --- Web Server Logic ---
log(`HTTP server starting on http://localhost:${PORT}`);

await serve(async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const requestId = crypto.randomUUID(); // Generate unique ID for this request

    log(`[${requestId}] Received request: ${req.method} ${path} from ${req.headers.get("user-agent") || "unknown agent"}`);

    // --- Webhook Endpoint ---
    if (req.method === "POST" && path === "/webhook/happyscribe") {
        log(`[${requestId}] Processing Happy Scribe Webhook...`);
        const startTime = Date.now();
        try {
            const webhookPayload = await req.json();
            log(`[${requestId}] Webhook Payload Received:`, JSON.stringify(webhookPayload));

            // --- IMPORTANT: Verify the webhook signature if Happy Scribe provides one ---
            // This ensures the request is actually from Happy Scribe.
            // Check Happy Scribe documentation for webhook security. If they provide
            // a signature header, you should validate it here using a shared secret.

            // Assuming the payload contains the transcription ID
            // Adjust based on the actual payload structure from Happy Scribe docs!
            // Common structures: `event.data.id`, `transcription.id`, `id` etc.
            // Example: Check for common patterns, add more as needed
            const transcriptionId = webhookPayload?.transcription?.id
                                 || webhookPayload?.id
                                 || webhookPayload?.data?.id // Another possible structure
                                 || webhookPayload?.payload?.id; // Yet another

            if (!transcriptionId) {
                log(`[${requestId}] ERROR: Transcription ID not found in webhook payload. Payload:`, JSON.stringify(webhookPayload));
                return new Response("Transcription ID missing", { status: 400 });
            }
            log(`[${requestId}] Extracted Transcription ID: ${transcriptionId}`);

            // 1. Get Transcription Text
            const transcriptionText = await getHappyScribeTranscriptionText(transcriptionId);

            // 2. Process Text with GPT-4 to extract detailed JSON
            // Define the expected structure based on user feedback
            interface PricingRequestDetails {
                nombre_cliente: string | null;
                correo_electronico: string | null;
                numero_telefono: string | null; // Include country code if possible
                ciudad_origen: string | null;
                codigo_postal_origen: string | null;
                pais_origen: string | null;
                ciudad_destino: string | null;
                codigo_postal_destino: string | null;
                pais_destino: string | null;
                tipo_servicio: string | null; // e.g., puerta a puerta, puerto a puerto
                tipo_embalaje: string | null; // e.g., profesional completo, parcial, PBO
                fecha_estimada_mudanza: string | null;
                volumen_estimado_m3: number | string | null; // Allow string for "1x20ft" etc.
                contenido_general: string | null; // e.g., muebles, cajas, vehiculo
                incluye_vehiculo: boolean | null;
                vehiculo_marca_modelo_ano: string | null;
                vehiculo_valor_usd: number | null;
                vehiculo_condicion: string | null; // nuevo o usado
                vehiculo_titulo_registro: boolean | null; // a nombre del cliente?
                relacion_destino: string | null; // ciudadano, residente, visa, etc.
                referido_por: string | null;
                codigo_descuento: string | null;
                notas_especiales: string | null;
            }

            let pricingInfoJson: PricingRequestDetails | null = null; // Initialize as null
            let noteTitle = `Pricing Request from Call (HS ID: ${transcriptionId})`; // Default title
            let noteContent = `Raw Transcription:\n${transcriptionText}`; // Default content if GPT fails

            // --- GPT Processing Block ---
            log(`[${requestId}] Starting GPT-4 processing for transcription ID: ${transcriptionId}`);
            const gptStartTime = Date.now();
            try {
                // Updated prompt asking for the specific fields in JSON format
                const gptPrompt = `
                    Analyze the following meeting transcript regarding an international move request.
                    Extract the required information and return ONLY a valid JSON object matching this structure.
                    Use null for any fields that are not mentioned or cannot be determined from the transcript.

                    JSON Structure:
                    {
                      "nombre_cliente": "string | null",
                      "correo_electronico": "string | null",
                      "numero_telefono": "string | null",
                      "ciudad_origen": "string | null",
                      "codigo_postal_origen": "string | null",
                      "pais_origen": "string | null",
                      "ciudad_destino": "string | null",
                      "codigo_postal_destino": "string | null",
                      "pais_destino": "string | null",
                      "tipo_servicio": "string | null",
                      "tipo_embalaje": "string | null",
                      "fecha_estimada_mudanza": "string | null",
                      "volumen_estimado_m3": "number | string | null",
                      "contenido_general": "string | null",
                      "incluye_vehiculo": "boolean | null",
                      "vehiculo_marca_modelo_ano": "string | null",
                      "vehiculo_valor_usd": "number | null",
                      "vehiculo_condicion": "string | null",
                      "vehiculo_titulo_registro": "boolean | null",
                      "relacion_destino": "string | null",
                      "referido_por": "string | null",
                      "codigo_descuento": "string | null",
                      "notas_especiales": "string | null"
                    }

                    Transcript:
                    ---
                    ${transcriptionText}
                    ---
                `;
                const gptResponse = await gptCaller`${gptPrompt}`; // Assuming gptCaller includes logging
                log(`[${requestId}] Raw GPT-4 Response received (length: ${gptResponse?.length ?? 0}).`);
                // log(`[${requestId}] Raw GPT-4 Response:`, gptResponse); // Optional: Log full response if needed for debug

                log(`[${requestId}] Attempting to parse GPT-4 JSON response...`);
                // Attempt to parse the JSON response
                const parsedJson = JSON.parse(gptResponse);
                log(`[${requestId}] Successfully parsed GPT-4 JSON response.`);

                // Basic validation if it's an object (can add more specific checks later)
                if (typeof parsedJson === 'object' && parsedJson !== null) {
                    pricingInfoJson = parsedJson as PricingRequestDetails; // Type assertion
                    log(`[${requestId}] GPT-4 JSON assigned to pricingInfoJson.`);

                    // Construct detailed Note Title and Content
                    const customerName = pricingInfoJson.nombre_cliente || "Unknown Customer";
                    noteTitle = `Pricing Request: ${customerName} (HS ID: ${transcriptionId})`;

                    // Build the note content field by field
                    noteContent = `== Pricing Request Details (Extracted by AI) ==\n\n`;
                    noteContent += `Nombre Cliente: ${pricingInfoJson.nombre_cliente ?? 'N/A'}\n`;
                    noteContent += `Correo Electrónico: ${pricingInfoJson.correo_electronico ?? 'N/A'}\n`;
                    noteContent += `Teléfono: ${pricingInfoJson.numero_telefono ?? 'N/A'}\n\n`;

                    noteContent += `Origen: ${pricingInfoJson.ciudad_origen ?? 'N/A'} (${pricingInfoJson.codigo_postal_origen ?? 'N/A'}), ${pricingInfoJson.pais_origen ?? 'N/A'}\n`;
                    noteContent += `Destino: ${pricingInfoJson.ciudad_destino ?? 'N/A'} (${pricingInfoJson.codigo_postal_destino ?? 'N/A'}), ${pricingInfoJson.pais_destino ?? 'N/A'}\n\n`;

                    noteContent += `Tipo Servicio: ${pricingInfoJson.tipo_servicio ?? 'N/A'}\n`;
                    noteContent += `Tipo Embalaje: ${pricingInfoJson.tipo_embalaje ?? 'N/A'}\n`;
                    noteContent += `Fecha Estimada Mudanza: ${pricingInfoJson.fecha_estimada_mudanza ?? 'N/A'}\n`;
                    noteContent += `Volumen Estimado: ${pricingInfoJson.volumen_estimado_m3 ?? 'N/A'}\n`;
                    noteContent += `Contenido General: ${pricingInfoJson.contenido_general ?? 'N/A'}\n\n`;

                    noteContent += `Incluye Vehículo: ${pricingInfoJson.incluye_vehiculo === null ? 'N/A' : pricingInfoJson.incluye_vehiculo ? 'Sí' : 'No'}\n`;
                    if (pricingInfoJson.incluye_vehiculo) {
                        noteContent += `  Vehículo: ${pricingInfoJson.vehiculo_marca_modelo_ano ?? 'N/A'}\n`;
                        noteContent += `  Valor (USD): ${pricingInfoJson.vehiculo_valor_usd ?? 'N/A'}\n`;
                        noteContent += `  Condición: ${pricingInfoJson.vehiculo_condicion ?? 'N/A'}\n`;
                        noteContent += `  Título a Nombre Cliente: ${pricingInfoJson.vehiculo_titulo_registro === null ? 'N/A' : pricingInfoJson.vehiculo_titulo_registro ? 'Sí' : 'No'}\n`;
                    }
                    noteContent += `\n`;

                    noteContent += `Relación con Destino: ${pricingInfoJson.relacion_destino ?? 'N/A'}\n`;
                    noteContent += `Referido Por: ${pricingInfoJson.referido_por ?? 'N/A'}\n`;
                    noteContent += `Código Descuento: ${pricingInfoJson.codigo_descuento ?? 'N/A'}\n\n`;

                    noteContent += `Notas Especiales:\n${pricingInfoJson.notas_especiales ?? 'N/A'}\n\n`;
                    noteContent += `--- Raw Transcription Snippet ---\n${transcriptionText.substring(0, 500)}...`; // Keep snippet

                    log(`[${requestId}] Successfully processed transcription with GPT-4. Time taken: ${Date.now() - gptStartTime}ms`);
                    log(`[${requestId}] Constructed Note Title: "${noteTitle}"`);
                    // log(`[${requestId}] Constructed Note Content:`, noteContent); // Optional: Log full content if needed
                } else {
                     log(`[${requestId}] ERROR: GPT-4 response was not a valid JSON object after parsing. Parsed type: ${typeof parsedJson}`);
                     throw new Error("GPT-4 response was not a valid JSON object.");
                }

            } catch (gptError) {
                log(`[${requestId}] CATCH ERROR during GPT-4 processing or JSON parsing:`, gptError instanceof Error ? gptError.message : String(gptError), gptError);
                log(`[${requestId}] GPT Processing/Parsing failed after ${Date.now() - gptStartTime}ms`);
                // Use default title/content if GPT processing fails
                noteTitle = `Pricing Request from Call (HS ID: ${transcriptionId}) - GPT Error`;
                noteContent = `Error processing transcript with AI: ${gptError.message}\n\nRaw Transcription:\n${transcriptionText}`;
                // Ensure pricingInfoJson remains null or default if error occurs before assignment
                pricingInfoJson = null;
            }

            // --- Find Lead ID ---
            let leadId: string | null = null;
            if (pricingInfoJson?.correo_electronico || pricingInfoJson?.numero_telefono) {
                log(`[${requestId}] Attempting to find Zoho Lead ID...`);
                leadId = await findZohoLeadId(pricingInfoJson.correo_electronico, pricingInfoJson.numero_telefono);
                if (leadId) {
                    log(`[${requestId}] Found matching Lead ID: ${leadId}`);
                } else {
                    log(`[${requestId}] No matching Lead found or search failed.`);
                }
            } else {
                 log(`[${requestId}] Skipping Lead search as no email or phone was extracted by GPT-4.`);
            }


            // --- Zoho Note Creation Block ---
            log(`[${requestId}] Starting Zoho Note creation (linking to Lead: ${leadId ?? 'No'})...`);
            const zohoStartTime = Date.now();
            try {
                // Pass the found leadId (or null) to createZohoNote
                await createZohoNote(noteTitle, noteContent, leadId);
                log(`[${requestId}] Zoho Note creation attempt finished. Time taken: ${Date.now() - zohoStartTime}ms`);
            } catch (zohoError) {
                 log(`[${requestId}] CATCH ERROR during Zoho Note creation:`, zohoError instanceof Error ? zohoError.message : String(zohoError), zohoError);
                 log(`[${requestId}] Zoho Note creation failed after ${Date.now() - zohoStartTime}ms`);
                 // Decide if we should still return 200 to Happy Scribe or an error
                 // Returning 500 might cause retries which could call GPT again.
                 // Returning 200 acknowledges receipt but means the Zoho step failed silently to the caller.
                 // Let's return 500 for now to indicate partial failure.
                 throw new Error("Webhook processed, but failed during Zoho Note creation.", { cause: zohoError });
            }


            const totalTime = Date.now() - startTime;
            log(`[${requestId}] Successfully processed webhook for transcription ${transcriptionId}. Total time: ${totalTime}ms`);
            return new Response("Webhook processed successfully", { status: 200 });

        } catch (error) {
            const totalTime = Date.now() - startTime;
            log(`[${requestId}] CATCH ERROR processing webhook:`, error instanceof Error ? error.message : String(error), error);
            log(`[${requestId}] Webhook processing failed after ${totalTime}ms`);
            // Return 500 so Happy Scribe might retry (check their retry policy)
            return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
        }
    }

    // --- Health Check Endpoint ---
    if (req.method === "GET" && path === "/health") {
        log(`[${requestId}] Responding to health check.`);
        return new Response("OK", { status: 200 });
    }

    // --- Default: Not Found ---
    log(`[${requestId}] Path not handled: ${path}. Returning 404.`);
    return new Response("Not Found", { status: 404 });

}, { port: PORT });

log(`Server listening on http://localhost:${PORT}`); // Log after server starts listening
