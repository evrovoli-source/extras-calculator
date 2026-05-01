const express = require('express');
const path = require('path');

const app = express();

app.use(express.json({ limit: '25mb' }));

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');
  return JSON.parse(match[0]);
}

function normalizeResult(result) {
  const charged = result.charged_items || result.extras || [];
  const excluded = result.excluded_items || [];
  const uncertain = result.uncertain_items || [];

  const seen = new Set();

  const cleanCharged = charged
    .filter(item => item && item.code)
    .map(item => ({
      code: String(item.code).trim(),
      name: item.name || item.description || '',
      value: Number(item.value || 0),
      reason: item.reason || item.note || ''
    }))
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return item.value > 0;
    });

  const excludedCodes = new Set(
    excluded
      .filter(item => item && item.code)
      .map(item => String(item.code).trim())
  );

  const finalCharged = cleanCharged.filter(item => !excludedCodes.has(item.code));

  const total = finalCharged.reduce((sum, item) => sum + Number(item.value || 0), 0);

  return {
    vehicle: result.vehicle || '',
    vehicle_type_code: result.vehicle_type_code || '',
    extras: finalCharged.map(item => ({
      name: item.name,
      code: item.code,
      value: item.value,
      note: item.reason
    })),
    charged_items: finalCharged,
    excluded_items: excluded,
    uncertain_items: uncertain,
    packages_used: result.packages_used || [],
    not_found: result.not_found || [],
    total
  };
}

function addServerInstructions(body) {
  const extraInstruction = {
    type: 'text',
    text: `
ΤΕΛΙΚΗ ΟΔΗΓΙΑ SERVER:
Επέστρεψε ΜΟΝΟ ένα JSON object.
Μην γράψεις markdown, backticks, σχόλια ή εξηγήσεις.

Το total πρέπει να είναι άθροισμα ΜΟΝΟ των charged_items/extras.
Αν ένας κωδικός είναι included σε πακέτο, ΜΗΝ τον βάλεις στα charged_items.
Αν δεν είσαι σίγουρος, βάλ' τον στα uncertain_items και ΜΗΝ τον χρεώσεις.
`
  };

  const copy = { ...body };

  copy.temperature = 0;
  copy.max_tokens = copy.max_tokens || 4000;

  if (copy.messages && copy.messages[0] && Array.isArray(copy.messages[0].content)) {
    copy.messages[0].content.push(extraInstruction);
  }

  return copy;
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'Missing ANTHROPIC_API_KEY on server'
      });
    }

    const requestBody = addServerInstructions(req.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const raw = await response.text();

    if (!response.ok) {
      return res.status(response.status).send(raw);
    }

    const anthropicResponse = JSON.parse(raw);
    const aiText = (anthropicResponse.content || [])
      .map(part => part.text || '')
      .join('');

    const aiJson = extractJson(aiText);
    const finalResult = normalizeResult(aiJson);

    return res.status(200).json({
      content: [
        {
          type: 'text',
          text: JSON.stringify(finalResult)
        }
      ]
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
