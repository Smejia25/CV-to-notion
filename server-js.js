import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import FormData from "form-data";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: "20mb" }));
app.use(express.static(join(__dirname, "public")));

// ─── Notion Proxy ────────────────────────────────────────────────
// All Notion API calls go through here to avoid CORS + keep token server-side

app.all("/api/notion/*", async (req, res) => {
  const notionKey = req.headers["x-notion-key"];
  if (!notionKey) return res.status(401).json({ error: "Missing Notion API key" });

  const path = req.params[0]; // everything after /api/notion/
  const url = `https://api.notion.com/v1/${path}`;

  try {
    const opts = {
      method: req.method,
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    };
    if (["POST", "PATCH", "PUT"].includes(req.method) && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, opts);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CV Extraction ───────────────────────────────────────────────

function buildExtractionPrompt(schema) {
  if (!schema || !schema.length) {
    // Fallback if no schema provided
    return `Extract the following fields from this CV/resume. Return ONLY a valid JSON object with these keys (use null for any field not found):
{
  "Name": "Full name",
  "Email": "Email address",
  "Phone Number": "Phone number",
  "LinkedIn Profile": "LinkedIn profile URL",
  "Location": "City Province/State (NO commas)",
  "Source": "Default to 'LinkedIn applicant'",
  "Salary Expct.": "Salary expectation or null"
}
No markdown, no backticks, no explanation. Just the JSON object.`;
  }

  const extractableTypes = ["title", "email", "rich_text", "url", "select", "number", "phone_number"];
  const fields = schema.filter(s => extractableTypes.includes(s.type));

  const fieldDescriptions = fields.map(f => {
    let hint = "";
    switch (f.type) {
      case "title": hint = "text value"; break;
      case "email": hint = "email address"; break;
      case "rich_text": hint = "text value"; break;
      case "url": hint = "URL"; break;
      case "number": hint = "number"; break;
      case "phone_number": hint = "phone number"; break;
      case "select":
        if (f.options?.length) {
          hint = `one of: ${f.options.slice(0, 15).join(", ")}. Pick the closest match or use a short value`;
        } else {
          hint = "short text value";
        }
        break;
    }
    return `  "${f.name}": "${hint} (or null if not found)"`;
  }).join(",\n");

  return `Extract the following fields from this CV/resume. Return ONLY a valid JSON object with these keys (use null for any field not found).
IMPORTANT: For select fields, NO commas allowed in values. Use spaces instead (e.g. 'Montréal QC' not 'Montréal, QC').

{
${fieldDescriptions}
}
No markdown, no backticks, no explanation. Just the JSON object.`;
}

async function extractWithAnthropic(apiKey, base64, mediaType, prompt) {
  const isPdf = mediaType.includes("pdf");
  const content = [
    isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: prompt },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function extractWithOpenAI(apiKey, base64, mediaType, prompt) {
  const isPdf = mediaType.includes("pdf");

  const contentParts = [];
  if (isPdf) {
    contentParts.push({
      type: "input_file",
      filename: "cv.pdf",
      file_data: `data:application/pdf;base64,${base64}`,
    });
  } else {
    contentParts.push({
      type: "input_image",
      image_url: `data:${mediaType};base64,${base64}`,
    });
  }
  contentParts.push({ type: "input_text", text: prompt });

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: contentParts }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.output?.filter(b => b.type === "message")
    .flatMap(b => b.content).filter(c => c.type === "output_text")
    .map(c => c.text).join("") || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function extractWithGemini(apiKey, base64, mediaType, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mediaType, data: base64 } },
          { text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

app.post("/api/extract-cv", upload.single("cv"), async (req, res) => {
  try {
    const { provider, aiKey } = req.body;
    const schema = req.body.schema ? JSON.parse(req.body.schema) : null;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!aiKey) return res.status(400).json({ error: "Missing AI API key" });

    const base64 = req.file.buffer.toString("base64");
    const mediaType = req.file.mimetype;
    const prompt = buildExtractionPrompt(schema);

    let fields;
    switch (provider) {
      case "anthropic":
        fields = await extractWithAnthropic(aiKey, base64, mediaType, prompt);
        break;
      case "openai":
        fields = await extractWithOpenAI(aiKey, base64, mediaType, prompt);
        break;
      case "gemini":
        fields = await extractWithGemini(aiKey, base64, mediaType, prompt);
        break;
      default:
        return res.status(400).json({ error: "Invalid provider" });
    }

    res.json({ fields });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fetch page text content from Notion ─────────────────────────

async function fetchPageText(notionKey, pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
    headers: {
      "Authorization": `Bearer ${notionKey}`,
      "Notion-Version": "2022-06-28",
    },
  });
  const data = await res.json();
  if (!data.results) return "";

  const lines = [];
  for (const block of data.results) {
    const richTexts =
      block[block.type]?.rich_text ||
      block[block.type]?.text ||
      block[block.type]?.caption || [];
    if (Array.isArray(richTexts)) {
      const text = richTexts.map(t => t.plain_text || "").join("");
      if (text) lines.push(text);
    }
    // Also grab title for child_page/child_database
    if (block.type === "child_page") lines.push(block.child_page.title);
    if (block.type === "child_database") lines.push(block.child_database.title);
  }
  return lines.join("\n");
}

// ─── CV Analysis Prompt ──────────────────────────────────────────

const ANALYSIS_PROMPT = `You are a recruiter assistant. You will be given a candidate's CV and a Job Description (JD).

Produce notes following this EXACT structure. Use - for bullets, never use —. Be concise. Avoid all redundancy.

1. Requirements Met vs Not Met
- List which JD requirements the candidate meets
- List which JD requirements the candidate does NOT meet

2. Prescreening Questions Analysis
- If the CV contains prescreening answers, analyze them (translate French to English if needed)

3. Currently Studying?
- State if the candidate is currently studying and what

4. Gender and Age
- Give likely gender and estimated age based on CV clues

5. Employment History
- List each employer with their website URL, company location, dates worked
- Note any gaps in employment (including from last role to present)

6. Average Job Tenure
- Calculate the average time spent at each position

7. Why YES
- Reasons to move forward with this candidate

8. Why NOT
- Reasons to be cautious about this candidate

9. STAR Method Questions
- Based on the "Why NOT" points, provide 5 interview questions using the STAR method

10. Interview Decision
- Would you interview: YES or NO, with brief justification

11. Sector Summary
- List the sectors/industries the candidate has worked in

Do not use —. Use - instead. Concise language. No redundancy.`;

async function generateAnalysis(provider, apiKey, cvBase64, cvMediaType, jobDescription) {
  const prompt = `${ANALYSIS_PROMPT}\n\n--- JOB DESCRIPTION ---\n${jobDescription}\n\n--- CANDIDATE CV ---\n(attached as file)`;

  if (provider === "anthropic") {
    const isPdf = cvMediaType.includes("pdf");
    const content = [
      isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: cvBase64 } }
        : { type: "image", source: { type: "base64", media_type: cvMediaType, data: cvBase64 } },
      { type: "text", text: prompt },
    ];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  }

  if (provider === "openai") {
    const isPdf = cvMediaType.includes("pdf");
    const cvParts = [];
    if (isPdf) {
      cvParts.push({ type: "input_file", filename: "cv.pdf", file_data: `data:application/pdf;base64,${cvBase64}` });
    } else {
      cvParts.push({ type: "input_image", image_url: `data:${cvMediaType};base64,${cvBase64}` });
    }
    cvParts.push({ type: "input_text", text: prompt });

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: cvParts }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.output?.filter(b => b.type === "message")
      .flatMap(b => b.content).filter(c => c.type === "output_text")
      .map(c => c.text).join("") || "";
  }

  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: cvMediaType, data: cvBase64 } },
            { text: prompt },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  throw new Error("Invalid provider for analysis");
}

// Convert markdown-ish text to Notion blocks
function textToNotionBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    // Heading (## or numbered top-level like "1. ")
    const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/) || trimmed.match(/^(\d+\.\s+.+)$/);
    if (headingMatch && !trimmed.startsWith("- ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: headingMatch[1] || trimmed } }] },
      });
      continue;
    }

    // Bullet
    if (trimmed.startsWith("- ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: trimmed.slice(2) } }] },
      });
      continue;
    }

    // Regular paragraph
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: trimmed } }] },
    });
  }

  return blocks;
}

// ─── Upload CV to Notion ─────────────────────────────────────────

async function uploadFileToNotion(notionKey, buffer, filename, contentType) {
  const FILE_API_VERSION = "2022-06-28";

  // Step 1: Create a file upload object
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${notionKey}`,
      "Notion-Version": FILE_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename, content_type: contentType }),
  });
  const createData = await createRes.json();
  if (createData.object === "error") throw new Error(createData.message);

  // Step 2: Send the actual file
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });

  const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${createData.id}/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${notionKey}`,
      "Notion-Version": FILE_API_VERSION,
      ...form.getHeaders(),
    },
    body: form,
  });
  const sendData = await sendRes.json();
  if (sendData.object === "error") throw new Error(sendData.message);

  return sendData.id; // file_upload ID to reference in properties
}

// ─── Create Notion Page ──────────────────────────────────────────

app.post("/api/create-candidate", upload.single("cv"), async (req, res) => {
  const { notionKey, dbId, roleId, roleName, aiProvider, aiKey } = req.body;
  const fields = JSON.parse(req.body.fields || "{}");
  const schema = req.body.schema ? JSON.parse(req.body.schema) : null;
  if (!notionKey || !dbId || !fields) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Build properties dynamically from schema
  const properties = {};

  // Upload CV to Notion first so we can reference it
  let cvFileUploadId = null;
  let cvFileName = null;
  if (req.file) {
    const titleField = schema?.find(s => s.type === "title");
    const name = (titleField ? fields[titleField.name] : null) || fields.Name || fields.applicant_name || "Unknown";
    const parts = name.trim().split(/\s+/);
    const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
    const ext = req.file.originalname.split(".").pop() || "pdf";
    cvFileName = `${lastName} ${firstName}${roleName ? " - " + roleName : ""}.${ext}`.trim();

    try {
      cvFileUploadId = await uploadFileToNotion(notionKey, req.file.buffer, cvFileName, req.file.mimetype);
    } catch (uploadErr) {
      console.error("Notion file upload failed:", uploadErr.message);
    }
  }

  if (schema) {
    for (const prop of schema) {
      const val = fields[prop.name];

      switch (prop.type) {
        case "title":
          properties[prop.name] = { title: [{ text: { content: val || "Unknown" } }] };
          break;
        case "email":
          if (val) properties[prop.name] = { email: val };
          break;
        case "rich_text":
          if (val) properties[prop.name] = { rich_text: [{ text: { content: val } }] };
          break;
        case "url":
          if (val) properties[prop.name] = { url: val };
          break;
        case "number":
          if (val) properties[prop.name] = { number: parseFloat(val) || null };
          break;
        case "select":
          if (val) properties[prop.name] = { select: { name: String(val).replace(/,/g, "") } };
          break;
        case "status":
          properties[prop.name] = { status: { name: val || prop.defaultValue || "Applied" } };
          break;
        case "date":
          // Never auto-fill date fields
          break;
        case "checkbox":
          properties[prop.name] = { checkbox: val === true || val === "true" || false };
          break;
        case "relation":
          if (prop.name === "Applied for" && roleId) {
            properties[prop.name] = { relation: [{ id: roleId }] };
          }
          break;
        case "files":
          if (cvFileUploadId && (prop.name === "CV" || prop.name.toLowerCase().includes("cv") || prop.name.toLowerCase().includes("resume"))) {
            properties[prop.name] = {
              files: [{ type: "file_upload", file_upload: { id: cvFileUploadId }, name: cvFileName }],
            };
          }
          break;
      }
    }
  } else {
    // Fallback: hardcoded properties if no schema
    properties["Name"] = { title: [{ text: { content: fields.Name || fields.applicant_name || "Unknown" } }] };
    if (fields.Email || fields.email) properties["Email"] = { email: fields.Email || fields.email };
    if (fields["Phone Number"] || fields.phone) properties["Phone Number"] = { rich_text: [{ text: { content: fields["Phone Number"] || fields.phone } }] };
    if (fields["LinkedIn Profile"] || fields.linkedin) properties["LinkedIn Profile"] = { url: fields["LinkedIn Profile"] || fields.linkedin };
    if (fields.Location || fields.location) properties["Location"] = { select: { name: (fields.Location || fields.location).replace(/,/g, "") } };
    if (fields.Source || fields.source) properties["Source"] = { select: { name: (fields.Source || fields.source).replace(/,/g, "") } };
    properties["Applicant Status"] = { status: { name: "Interested - to schedule" } };
    // Don't auto-fill dates
    if (roleId) properties["Applied for"] = { relation: [{ id: roleId }] };
    if (cvFileUploadId) properties["CV"] = { files: [{ type: "file_upload", file_upload: { id: cvFileUploadId }, name: cvFileName }] };
  }

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties,
      }),
    });

    const data = await response.json();
    if (data.object === "error") {
      return res.status(400).json({ error: data.message, details: data });
    }

    // Generate analysis notes if we have a role and CV
    if (roleId && req.file && aiProvider && aiKey) {
      try {
        // Fetch the job description from the role page
        const jdText = await fetchPageText(notionKey, roleId);

        if (jdText) {
          const cvBase64 = req.file.buffer.toString("base64");
          const cvMediaType = req.file.mimetype;

          // Generate analysis
          const analysis = await generateAnalysis(aiProvider, aiKey, cvBase64, cvMediaType, jdText);

          // Convert to Notion blocks and append to the created page
          if (analysis) {
            const blocks = [
              {
                object: "block",
                type: "heading_2",
                heading_2: { rich_text: [{ type: "text", text: { content: "Recruiter Notes" } }] },
              },
              ...textToNotionBlocks(analysis),
            ];

            // Notion API limits to 100 blocks per request
            for (let i = 0; i < blocks.length; i += 100) {
              await fetch(`https://api.notion.com/v1/blocks/${data.id}/children`, {
                method: "PATCH",
                headers: {
                  "Authorization": `Bearer ${notionKey}`,
                  "Notion-Version": "2022-06-28",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
              });
            }
          }
        }
      } catch (analysisErr) {
        // Don't fail the whole request if analysis fails - page was already created
        console.error("Analysis generation failed:", analysisErr.message);
      }
    }

    res.json({ success: true, page: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fallback to index.html for SPA ─────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
