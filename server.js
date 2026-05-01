const express = require('express');
const path = require('path');

const app = express();

app.use(express.json({ limit: '25mb' }));

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');
  return JSON.parse(match[0]);
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function normalizeResult(result) {
  const charged = result.charged_items || result.extras || [];
  const excluded = result.excluded_items || [];
  const uncertain = result.uncertain_items || [];

  const datacardCodes = new Set(
    (result.datacard_codes || [])
      .map(normalizeCode)
      .filter(Boolean)
  );

  const seen = new Set();
  const rejected = [...excluded];

  let cleanCharged = charged
    .filter(item => item && item.code)
    .map(item => ({
      code: normalizeCode(item.code),
      name: item.name || item.description || '',
      value: Number(item.value || 0),
      reason: item.reason || item.note || ''
    }))
    .filter(item => {
      if (!item.code) return false;

      if (seen.has(item.code)) {
        rejected.push({
          code: item.code,
          name: item.name,
          value_if_standalone: item.value,
          reason: 'duplicate_code',
          included_in: null
        });
        return false;
      }

      seen.add(item.code);

      if (item.value <= 0) {
        rejected.push({
          code: item.code,
          name: item.name,
          value_if_standalone: item.value,
          reason: 'zero_or_invalid_price',
          included_in: null
        });
        return false;
      }

      return true;
    });

  // ΚΡΙΣΙΜΟΣ ΚΑΝΟΝΑΣ:
  // Αν το AI έδωσε datacard_codes, χρεώνουμε ΜΟΝΟ κωδικούς που υπάρχουν εκεί.
  if (datacardCodes.size > 0) {
    cleanCharged = cleanCharged.filter(item => {
      if (!datacardCodes.has(item.code)) {
        rejected.push({
          code: item.code,
          name: item.name,
          value_if_standalone: item.value,
          reason: 'not_explicitly_in_datacard',
          included_in: null
        });
        return false;
      }
      return true;
    });
  }

  // Αν κάτι είναι ήδη στα excluded_items, δεν χρεώνεται.
  const excludedCodes = new Set(
    rejected
      .filter(item => item && item.code)
      .map(item => normalizeCode(item.code))
  );

  let finalCharged = cleanCharged.filter(item => !excludedCodes.has(item.code));

  // Γενικό package filter:
  // Αν το AI δηλώσει included_in για κάποιο excluded item, ο server το αφαιρεί οπωσδήποτε.
  const includedByPackageCodes = new Set(
    rejected
      .filter(item => item && item.reason === 'included_in_package' && item.code)
      .map(item => normalizeCode(item.code))
  );

  finalCharged = finalCharged.filter(item => !includedByPackageCodes.has(item.code));

  const total = finalCharged.reduce((sum, item) => sum + Number(item.value || 0), 0);

  return {
    vehicle: result.vehicle || '',
    vehicle_type_code: result.vehicle_type_code || '',
    datacard_codes: Array.from(datacardCodes),
    extras: finalCharged.map(item => ({
      name: item.name,
      code: item.code,
      value: item.value,
      note: item.reason
    })),
    charged_items: finalCharged,
    excluded_items: rejected,
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
ΤΕΛΙΚΗ ΟΔΗΓΙΑ SERVER - ΥΠΟΧΡΕΩΤΙΚΗ:

Επέστρεψε ΜΟΝΟ ένα JSON object.
Μην γράψεις markdown, backticks, σχόλια ή εξηγήσεις.

ΥΠΟΧΡΕΩΤΙΚΑ επέστρεψε πεδίο:
"datacard_codes": []

Το datacard_codes πρέπει να περιέχει ΟΛΟΥΣ τους κωδικούς εξοπλισμού που υπάρχουν ΡΗΤΑ στη DATA CARD, όπως 218, P27, P49, 890U, U59 κλπ.

ΚΡΙΣΙΜΟ:
Μην χρεώσεις κανέναν κωδικό που δεν υπάρχει ρητά στο datacard_codes.
Αν ένας κωδικός υπάρχει μόνο στον τιμοκατάλογο, μόνο σε condition, μόνο σε included list ή μόνο σε περιγραφή πακέτου, ΔΕΝ χρεώνεται.

Αν ένα package υπάρχει στη datacard και χρεώνεται, τότε οι κωδικοί που περιλαμβάνει δεν χρεώνονται ξανά.
Αυτοί μπαίνουν στο excluded_items με:
reason: "included_in_package"
included_in: "κωδικός πακέτου"

Το total πρέπει να είναι άθροισμα ΜΟΝΟ των charged_items.
Αν δεν είσαι σίγουρος για κωδικό, βάλ' τον στα uncertain_items και ΜΗΝ τον χρεώσεις.
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
  console.error('SERVER ERROR:', err);
  return res.status(500).json({
    error: err.message,
    stack: err.stack
  });
}
]);
app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
