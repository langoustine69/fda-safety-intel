import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync } from 'fs';

const agent = await createAgent({
  name: 'fda-safety-intel',
  version: '1.0.0',
  description: 'FDA Safety Intelligence - Drug adverse events, food/drug/device recalls, enforcement actions. Real-time safety data from OpenFDA.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

const FDA_BASE = 'https://api.fda.gov';

async function fetchFDA(endpoint: string): Promise<any> {
  const response = await fetch(`${FDA_BASE}${endpoint}`);
  if (!response.ok) {
    throw new Error(`FDA API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// === FREE: Safety Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of recent FDA safety activity - try before you buy. Shows recent recalls across drugs, food, and devices.',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [drugRecalls, foodRecalls, deviceRecalls] = await Promise.all([
      fetchFDA('/drug/enforcement.json?limit=3'),
      fetchFDA('/food/enforcement.json?limit=3'),
      fetchFDA('/device/recall.json?limit=3'),
    ]);

    return {
      output: {
        summary: {
          drugRecalls: drugRecalls.meta?.results?.total || 0,
          foodRecalls: foodRecalls.meta?.results?.total || 0,
          deviceRecalls: deviceRecalls.meta?.results?.total || 0,
        },
        recentDrugRecalls: drugRecalls.results?.slice(0, 3).map((r: any) => ({
          recallNumber: r.recall_number,
          reason: r.reason_for_recall?.substring(0, 150),
          status: r.status,
        })),
        recentFoodRecalls: foodRecalls.results?.slice(0, 3).map((r: any) => ({
          recallNumber: r.recall_number,
          reason: r.reason_for_recall?.substring(0, 150),
          status: r.status,
        })),
        recentDeviceRecalls: deviceRecalls.results?.slice(0, 3).map((r: any) => ({
          productCode: r.product_code,
          rootCause: r.root_cause_description,
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'OpenFDA (live)',
      },
    };
  },
});

// === PAID $0.001: Drug Adverse Events ===
addEntrypoint({
  key: 'drug-events',
  description: 'Search drug adverse event reports. Find safety issues, side effects, and patient outcomes for specific drugs.',
  input: z.object({
    drug: z.string().describe('Drug name to search for'),
    limit: z.number().optional().default(10).describe('Number of results (1-100)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const { drug, limit } = ctx.input;
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    
    const data = await fetchFDA(`/drug/event.json?search=patient.drug.medicinalproduct:"${encodeURIComponent(drug)}"&limit=${safeLimit}`);
    
    return {
      output: {
        drug,
        totalReports: data.meta?.results?.total || 0,
        events: data.results?.map((r: any) => ({
          safetyReportId: r.safetyreportid,
          serious: r.serious === '1',
          seriousDeath: r.seriousnessdeath === '1',
          reactions: r.patient?.reaction?.map((rx: any) => rx.reactionmeddrapt) || [],
          reporterCountry: r.primarysource?.reportercountry,
          receiveDate: r.receivedate,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Drug Recalls ===
addEntrypoint({
  key: 'drug-recalls',
  description: 'Search drug recall enforcement actions. Get recall reasons, classifications, and affected products.',
  input: z.object({
    query: z.string().optional().describe('Search term (drug name, company, etc.)'),
    status: z.enum(['Ongoing', 'Terminated', 'Pending', 'Completed']).optional().describe('Recall status filter'),
    limit: z.number().optional().default(20).describe('Number of results (1-100)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, status, limit } = ctx.input;
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    
    let searchParams = '';
    if (query) {
      searchParams += `search=product_description:"${encodeURIComponent(query)}"`;
    }
    if (status) {
      searchParams += searchParams ? `+AND+status:"${status}"` : `search=status:"${status}"`;
    }
    
    const endpoint = `/drug/enforcement.json?${searchParams}&limit=${safeLimit}`;
    const data = await fetchFDA(endpoint);
    
    return {
      output: {
        query,
        totalRecalls: data.meta?.results?.total || 0,
        recalls: data.results?.map((r: any) => ({
          recallNumber: r.recall_number,
          status: r.status,
          classification: r.classification,
          reasonForRecall: r.reason_for_recall,
          productDescription: r.product_description,
          recallingFirm: r.recalling_firm,
          city: r.city,
          state: r.state,
          country: r.country,
          voluntaryMandated: r.voluntary_mandated,
          initialFirmNotificationDate: r.initial_firm_notification,
          reportDate: r.report_date,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Food Recalls ===
addEntrypoint({
  key: 'food-recalls',
  description: 'Search food recall enforcement actions. Find contamination issues, allergen alerts, and affected food products.',
  input: z.object({
    query: z.string().optional().describe('Search term (product, company, etc.)'),
    classification: z.enum(['Class I', 'Class II', 'Class III']).optional().describe('Recall class (I=most serious)'),
    limit: z.number().optional().default(20).describe('Number of results (1-100)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, classification, limit } = ctx.input;
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    
    let searchParams = '';
    if (query) {
      searchParams += `search=product_description:"${encodeURIComponent(query)}"`;
    }
    if (classification) {
      searchParams += searchParams ? `+AND+classification:"${classification}"` : `search=classification:"${classification}"`;
    }
    
    const endpoint = `/food/enforcement.json?${searchParams}&limit=${safeLimit}`;
    const data = await fetchFDA(endpoint);
    
    return {
      output: {
        query,
        totalRecalls: data.meta?.results?.total || 0,
        recalls: data.results?.map((r: any) => ({
          recallNumber: r.recall_number,
          status: r.status,
          classification: r.classification,
          reasonForRecall: r.reason_for_recall,
          productDescription: r.product_description,
          recallingFirm: r.recalling_firm,
          distributionPattern: r.distribution_pattern,
          productQuantity: r.product_quantity,
          codeInfo: r.code_info,
          reportDate: r.report_date,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Device Recalls ===
addEntrypoint({
  key: 'device-recalls',
  description: 'Search medical device recalls. Get root cause analysis, affected device codes, and corrective actions.',
  input: z.object({
    query: z.string().optional().describe('Search term (device type, manufacturer, etc.)'),
    limit: z.number().optional().default(20).describe('Number of results (1-100)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, limit } = ctx.input;
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    
    let endpoint = `/device/recall.json?limit=${safeLimit}`;
    if (query) {
      endpoint = `/device/recall.json?search=product_code:"${encodeURIComponent(query)}"&limit=${safeLimit}`;
    }
    
    const data = await fetchFDA(endpoint);
    
    return {
      output: {
        query,
        totalRecalls: data.meta?.results?.total || 0,
        recalls: data.results?.map((r: any) => ({
          productCode: r.product_code,
          kNumbers: r.k_numbers,
          recallStatus: r.recall_status,
          rootCause: r.root_cause_description,
          actionType: r.event_type,
          firmFeiNumber: r.firm_fei_number,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.005: Comprehensive Safety Report ===
addEntrypoint({
  key: 'safety-report',
  description: 'Comprehensive safety report for a drug - combines adverse events, recalls, and enforcement data in one call.',
  input: z.object({
    drug: z.string().describe('Drug name for comprehensive safety analysis'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const { drug } = ctx.input;
    
    const [adverseEvents, drugRecalls] = await Promise.all([
      fetchFDA(`/drug/event.json?search=patient.drug.medicinalproduct:"${encodeURIComponent(drug)}"&limit=25`).catch(() => ({ results: [], meta: { results: { total: 0 } } })),
      fetchFDA(`/drug/enforcement.json?search=product_description:"${encodeURIComponent(drug)}"&limit=10`).catch(() => ({ results: [], meta: { results: { total: 0 } } })),
    ]);
    
    // Analyze adverse events
    const reactions: Record<string, number> = {};
    let seriousCount = 0;
    let deathCount = 0;
    
    adverseEvents.results?.forEach((event: any) => {
      if (event.serious === '1') seriousCount++;
      if (event.seriousnessdeath === '1') deathCount++;
      event.patient?.reaction?.forEach((rx: any) => {
        const name = rx.reactionmeddrapt;
        if (name) reactions[name] = (reactions[name] || 0) + 1;
      });
    });
    
    const topReactions = Object.entries(reactions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reaction, count]) => ({ reaction, count }));
    
    return {
      output: {
        drug,
        adverseEventsSummary: {
          totalReports: adverseEvents.meta?.results?.total || 0,
          seriousReports: seriousCount,
          deathReports: deathCount,
          topReactions,
        },
        recallsSummary: {
          totalRecalls: drugRecalls.meta?.results?.total || 0,
          recalls: drugRecalls.results?.slice(0, 5).map((r: any) => ({
            recallNumber: r.recall_number,
            status: r.status,
            classification: r.classification,
            reason: r.reason_for_recall?.substring(0, 200),
          })),
        },
        generatedAt: new Date().toISOString(),
        dataSource: 'OpenFDA (live)',
      },
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      },
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const icon = readFileSync('./icon.png');
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' },
    });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// ERC-8004 registration
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://fda-safety-intel-production.up.railway.app';
  
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'fda-safety-intel',
    description: 'FDA Safety Intelligence - Drug adverse events, food/drug/device recalls, real-time safety data from OpenFDA. 1 free + 5 paid endpoints via x402.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🏥 FDA Safety Intel running on port ${port}`);

export default { port, fetch: app.fetch };
