import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from "xlsx";
import { getApiUrl } from "./firebase";

// Helper to check if we are on a static environment like GitHub Pages
export function isStaticDeployment(): boolean {
  const hostname = window.location.hostname;
  return (
    hostname.includes("github.io") ||
    hostname.includes("vercel.app") ||
    hostname.includes("pages.dev") ||
    hostname.includes("netlify.app")
  );
}

// Get custom user API key from localStorage
export function getLocalApiKey(): string | null {
  return localStorage.getItem("rentasync_gemini_api_key");
}

// Set custom user API key in localStorage
export function setLocalApiKey(key: string | null) {
  if (key) {
    localStorage.setItem("rentasync_gemini_api_key", key.trim());
  } else {
    localStorage.removeItem("rentasync_gemini_api_key");
  }
}

// Initialize client-side Gemini AI safely
function getClientSideGemini(): GoogleGenAI {
  const key = getLocalApiKey();
  if (!key) {
    throw new Error("API_KEY_REQUIRED");
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

/**
 * Universal extract tax declarations and property spreadsheets
 */
export async function extractDocuments(payload: {
  text1?: string;
  fileData1?: string;
  mimeType1?: string;
  text2?: string;
  fileData2?: string;
  mimeType2?: string;
  propertiesFileData?: string;
  propertiesFileMime?: string;
  propertiesFileName?: string;
}): Promise<any> {
  const localKey = getLocalApiKey();

  // If NOT on static deploy and NO custom local key, always prefer standard backend
  if (!isStaticDeployment() && !localKey) {
    return await fetchFromBackend("/api/extract", payload);
  }

  // If we have a local key or we are on static hosting, use client-side Gemini!
  try {
    const ai = getClientSideGemini();
    const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la declaración de la renta de España (IRPF) (que puede ser del Contribuyente 1, del Contribuyente 2 o conjunta) y/o el documento de listado de inmuebles adjunto (que puede ser en formato texto, un documento PDF oficial o un listado Excel parseado) de uno o dos contribuyentes (pareja/cónyuges) y extraer TODA la información relevante sobre sus rentas del trabajo y sus inmuebles arrendados.

REGLAS DE EXTRACCIÓN SENSATAS:
1. Identifica al Contribuyente Principal (User 1) y al Cónyuge (User 2) si existe en los documentos. Si se encuentra información del cónyuge (User 2), establece hasPartner = true y extrae su nombre, DNI, ingresos brutos y netos de trabajo. Si no se menciona cónyuge, establece hasPartner = false.
2. Si se proporciona un archivo de inmuebles adicional (que puede ser texto parseado de un Excel, un PDF o CSV), este suele contener datos desglosados y más detallados sobre los inmuebles (tales como dirección, referencia catastral, inquilinos, DNI del inquilino, renta mensual, precio de adquisición o gastos de comunidad, IBI, seguros, etc.). Cruza y combina la información de todos los archivos proporcionados de forma inteligente. Si un inmueble se menciona en varios de los documentos adjuntos, consolídalo en un solo objeto sin duplicarlo, quedándote con los datos más detallados y completos de cada campo (por ejemplo, si en la declaración aparece el importe de alquiler total y en el listado de inmuebles aparecen los inquilinos con sus NIFs y gastos, combínalos!).
3. Extrae la información detallada de cada inmueble arrendado:
   - Dirección completa (address).
   - Referencia catastral (cadastralReference).
   - Propietario (owner): puede ser 'user1', 'user2' o 'both' (si se comparte).
   - Porcentajes de titularidad (ownershipPercentageUser1 y ownershipPercentageUser2) basados en el texto o documento. Si es de 'user1' es 100 y 0, si es de 'user2' es 0 y 100, si es compartido suele ser 50 y 50.
   - Nombre de los inquilinos (tenantName): Extrae los nombres de TODOS los inquilinos/arrendatarios de ese inmueble. Si hay varios en el documento, concaténalos todos separados por comas (ej. 'Juan Pérez García, María López Fernández').
   - NIF/DNI de los inquilinos (tenantDni): Extrae los DNI/NIF de TODOS los inquilinos de ese inmueble. Si hay varios en el documento, concaténalos todos separados por comas en el mismo orden que los nombres (ej. '12345678Z, 87654321X').
   - Cuantía de alquiler percibido anual o mensual (monthlyRent): Extrae la cantidad exactamente tal como aparece escrita físicamente en el documento para ese inmueble. Si es anual, divídelo por 12 para calcular el alquiler mensual estimado.
   - Precio de compra del inmueble / valor de adquisición (purchasePrice). Si no se detalla, haz una estimación sensata basada en las amortizaciones o pon un valor estimado razonable (e.g., 150000).
   - Porcentaje del valor catastral correspondiente al suelo (landValuePercent): suele oscilar entre 20% y 30%. Si no se especifica, por defecto pon 25.
   - Importe de amortización anual (amortizationAmount): usa el del texto o estima el 3% del valor de construcción.
   - Gastos deducibles como comunidad, IBI, seguros, reparaciones, etc. desglosados anuales o consolidados. Extrae los valores tal como aparecen escritos.
   - CRITICAL: Si el inmueble es de titularidad compartida (owner = 'both' o porcentajes < 100%) y los importes financieros correspondientes (alquiler, gastos, amortización, precio de compra) que aparecen en la declaración están prorrateados al porcentaje de participación (ej. 50%), DEBES calcular y devolver los importes normalizados al 100% de la capacidad de ese inmueble (es decir, el valor total absoluto del inmueble entero). La aplicación gestionará el inmueble al 100% y aplicará los repartos después de forma interna.
4. Devuelve un objeto JSON estructurado que siga el esquema exacto proporcionado.`;

    const contents: any[] = [{ text: systemPrompt }];

    if (payload.fileData1 && payload.mimeType1) {
      contents.push({ text: "--- DOCUMENTO 1: DECLARACIÓN RENTA USUARIO 1 (PDF) ---" });
      contents.push({
        inlineData: { mimeType: payload.mimeType1, data: payload.fileData1 },
      });
    } else if (payload.text1) {
      contents.push({ text: `--- DOCUMENTO 1: TEXTO RENTA USUARIO 1 ---\n\n${payload.text1}` });
    }

    if (payload.fileData2 && payload.mimeType2) {
      contents.push({ text: "--- DOCUMENTO 2: DECLARACIÓN RENTA USUARIO 2 (PDF) ---" });
      contents.push({
        inlineData: { mimeType: payload.mimeType2, data: payload.fileData2 },
      });
    } else if (payload.text2) {
      contents.push({ text: `--- DOCUMENTO 2: TEXTO RENTA USUARIO 2 ---\n\n${payload.text2}` });
    }

    if (payload.propertiesFileData && payload.propertiesFileMime) {
      const isExcel = payload.propertiesFileMime.includes("sheet") || 
                      payload.propertiesFileMime.includes("excel") || 
                      payload.propertiesFileMime.includes("spreadsheetml") ||
                      (payload.propertiesFileName && (payload.propertiesFileName.toLowerCase().endsWith(".xlsx") || payload.propertiesFileName.toLowerCase().endsWith(".xls")));

      if (isExcel) {
        try {
          const binaryString = window.atob(payload.propertiesFileData);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const workbook = XLSX.read(bytes.buffer, { type: "array" });
          const sheetTexts: string[] = [];
          for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(worksheet);
            sheetTexts.push(`Hoja: ${sheetName}\n${csv}`);
          }
          const excelText = sheetTexts.join("\n\n---\n\n");
          contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (EXCEL PARSEADO A CSV) ---\n\n${excelText}` });
        } catch (excelErr: any) {
          console.error("Error reading Excel in client browser:", excelErr);
          contents.push({ text: `[Error leyendo Excel en cliente: ${excelErr.message}]` });
        }
      } else if (payload.propertiesFileMime === "application/pdf") {
        contents.push({ text: "--- DOCUMENTO 3: DATOS DE INMUEBLES (PDF) ---" });
        contents.push({
          inlineData: { mimeType: "application/pdf", data: payload.propertiesFileData },
        });
      } else {
        const plainText = window.atob(payload.propertiesFileData);
        contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (TEXTO/CSV) ---\n\n${plainText}` });
      }
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            user1: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                dni: { type: Type.STRING },
                brutoTrabajo: { type: Type.NUMBER },
                netoTrabajo: { type: Type.NUMBER }
              },
              required: ["name", "dni", "brutoTrabajo", "netoTrabajo"]
            },
            user2: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                dni: { type: Type.STRING },
                brutoTrabajo: { type: Type.NUMBER },
                netoTrabajo: { type: Type.NUMBER },
                hasPartner: { type: Type.BOOLEAN }
              },
              required: ["name", "dni", "brutoTrabajo", "netoTrabajo", "hasPartner"]
            },
            properties: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  address: { type: Type.STRING },
                  cadastralReference: { type: Type.STRING },
                  owner: { type: Type.STRING },
                  ownershipPercentageUser1: { type: Type.NUMBER },
                  ownershipPercentageUser2: { type: Type.NUMBER },
                  tenantName: { type: Type.STRING },
                  tenantDni: { type: Type.STRING },
                  monthlyRent: { type: Type.NUMBER },
                  purchasePrice: { type: Type.NUMBER },
                  landValuePercent: { type: Type.NUMBER },
                  amortizationAmount: { type: Type.NUMBER },
                  expensesCommunity: { type: Type.NUMBER },
                  expensesIBI: { type: Type.NUMBER },
                  expensesInsurance: { type: Type.NUMBER },
                  expensesRepairs: { type: Type.NUMBER }
                },
                required: ["address", "cadastralReference", "owner", "tenantName", "tenantDni", "monthlyRent", "purchasePrice", "landValuePercent", "amortizationAmount"]
              }
            }
          },
          required: ["user1", "user2", "properties"]
        }
      }
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No se pudo obtener respuesta del modelo Gemini client-side.");
    }
    return JSON.parse(textOutput);
  } catch (error: any) {
    // If the error was because API key was missing, propagate it
    if (error.message === "API_KEY_REQUIRED") {
      throw error;
    }
    console.warn("Client-side direct extraction failed, attempting backend fallback...", error);
    // Fallback to backend fetch
    return await fetchFromBackend("/api/extract", payload);
  }
}

/**
 * Universal invoice/receipt image processing
 */
export async function extractInvoice(payload: {
  fileData: string;
  mimeType: string;
}): Promise<any> {
  const localKey = getLocalApiKey();

  if (!isStaticDeployment() && !localKey) {
    return await fetchFromBackend("/api/extract-invoice", payload);
  }

  try {
    const ai = getClientSideGemini();
    const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la imagen o PDF de una factura, recibo o comprobante de un gasto relacionado con una propiedad en alquiler, y extraer de forma extremadamente precisa la información necesaria para integrarla en la contabilidad fiscal del propietario.

Debes categorizar el gasto de forma inteligente de acuerdo con las siguientes categorías oficiales españolas de IRPF:
- 'repairs' (reparaciones y conservación de la vivienda: fontanero, pintor, averías, reformas de mantenimiento).
- 'ibi' (tributos y recargos: IBI, tasa de basuras, vados, etc.).
- 'insurance' (primas de contratos de seguro: hogar, responsabilidad civil, seguro de impago de alquiler).
- 'community' (gastos de comunidad: cuotas ordinarias y extraordinarias de la comunidad de propietarios).
- 'maintenance' (servicios de mantenimiento de instalaciones, limpieza, suministros de agua, luz, gas, calefacción si los abona el propietario).
- 'other' (cualquier otro gasto deducible: honorarios de la inmobiliaria o gestoría por el contrato, intereses de préstamos de compra, etc.).

Devuelve los importes como números decimales y las fechas en formato YYYY-MM-DD.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { text: systemPrompt },
        { text: "--- DOCUMENTO DE RECIBO/FACTURA ---" },
        {
          inlineData: { mimeType: payload.mimeType, data: payload.fileData },
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            amount: { type: Type.NUMBER },
            date: { type: Type.STRING },
            nif: { type: Type.STRING },
            description: { type: Type.STRING },
            category: { 
              type: Type.STRING, 
              description: "Categoría fiscal exacta del gasto: 'repairs', 'ibi', 'insurance', 'community', 'maintenance', 'other'."
            }
          },
          required: ["amount", "date", "description", "category"]
        }
      }
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("No se pudo obtener una respuesta válida del modelo Gemini client-side.");
    }
    return JSON.parse(textOutput);
  } catch (error: any) {
    if (error.message === "API_KEY_REQUIRED") {
      throw error;
    }
    console.warn("Client-side direct invoice extraction failed, attempting backend fallback...", error);
    return await fetchFromBackend("/api/extract-invoice", payload);
  }
}

/**
 * Universal rental contract generator
 */
export async function optimizeContract(payload: {
  contractContext: any;
  customPrompt: string;
}): Promise<any> {
  const localKey = getLocalApiKey();

  if (!isStaticDeployment() && !localKey) {
    return await fetchFromBackend("/api/optimize-contract", payload);
  }

  try {
    const ai = getClientSideGemini();
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: payload.customPrompt,
    });

    const contractText = response.text;
    if (!contractText) {
      throw new Error("No se pudo generar el texto del contrato.");
    }
    return { text: contractText };
  } catch (error: any) {
    if (error.message === "API_KEY_REQUIRED") {
      throw error;
    }
    console.warn("Client-side contract optimization failed, attempting backend fallback...", error);
    return await fetchFromBackend("/api/optimize-contract", payload);
  }
}

// Inner helper to fetch from Express server proxy
async function fetchFromBackend(endpoint: string, data: any): Promise<any> {
  const response = await fetch(getApiUrl(endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    let errorMessage = `Error del servidor (${response.status}).`;
    try {
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        const errData = await response.json();
        errorMessage = errData.error || errorMessage;
      } else {
        const text = await response.text();
        if (text && text.length < 200) {
          errorMessage = text;
        }
      }
    } catch (e) {}

    // Check if the error is due to missing backend routes (404) or failed fetch
    if (response.status === 404 && isStaticDeployment()) {
      throw new Error("API_KEY_REQUIRED");
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}
