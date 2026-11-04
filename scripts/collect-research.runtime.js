import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { getCollectorAnalysis } from '../src/features/ForecastResearch/features/EvidenceCollection/utils/collectorAnalysis.utils';
import { createCollectorBackgroundTasks } from './collect-research.background';
import {
  createResearchRepository,
  getResearchDatabaseConfiguration,
} from '../src/services/research/research.repository';
import { createLearningService } from '../src/services/research/learning.service';
import { createPaperTradingRepository } from '../src/services/research/paperTrading/paperTrading.repository';
import { createPaperTradingService } from '../src/services/research/paperTrading/paperTrading.service';
import { createPatternResearchRepository } from '../src/services/research/patterns/patternResearch.repository';
import { createPatternResearchService } from '../src/services/research/patterns/patternResearch.service';
import { createTradingAdvisorRepository } from '../src/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createConfiguredTradingAdvisorService } from '../src/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '../src/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createAdvisorHistoryTrialRepository } from '../src/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import { runResearchCollector } from '../src/features/ForecastResearch/features/EvidenceCollection/runResearchCollector';

export function parseCollectorOptions(args, projectRoot = process.cwd()) {
  const options = {
    once: false,
    help: false,
    report: false,
    paperTrading: false,
    paperReport: false,
    tradingAdvisor: false,
    advisorReport: false,
    statePath: path.join(projectRoot, 'data/kalshi-collector-state.json'),
  };
  for (const argument of args) {
    if (argument === '--once') options.once = true;
    else if (argument === '--report') options.report = true;
    else if (argument === '--paper-trading') options.paperTrading = true;
    else if (argument === '--paper-report') options.paperReport = true;
    else if (argument === '--trading-advisor') options.tradingAdvisor = true;
    else if (argument === '--advisor-report') options.advisorReport = true;
    else if (argument === '--help') options.help = true;
    else if (argument.startsWith('--state-file=')) {
      const selected = path.resolve(projectRoot, argument.slice('--state-file='.length));
      const relative = path.relative(path.join(projectRoot, 'data'), selected);
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        path.extname(selected) !== '.json'
      ) {
        throw new Error('--state-file must name a JSON file inside the project data directory.');
      }
      options.statePath = selected;
    } else throw new Error('Unknown collector option. Use --help for supported options.');
  }
  if (
    Number(options.once) +
      Number(options.report) +
      Number(options.paperReport) +
      Number(options.advisorReport) >
      1 ||
    ((options.paperTrading || options.tradingAdvisor) &&
      (options.once || options.report || options.paperReport || options.advisorReport))
  )
    throw new Error(
      'Use --paper-trading and/or --trading-advisor for continuous collection, or a report option by itself.',
    );
  return options;
}

export async function runCollectorCommand(args) {
  const options = parseCollectorOptions(args);
  if (options.help) {
    console.log(
      'Usage: npm run research:collect -- [--once | --report | --paper-report | --advisor-report | --paper-trading --trading-advisor] [--state-file=data/kalshi-collector-state.json]\nRequires Node 24. Records real Kalshi 12/9/6/3/1-minute checkpoints, paired variants, replay inputs, forward BRTI labels and official results. --once checks one current recorder step and local comparisons; it does not imply a completed outcome. --report analyzes saved comparisons and replays the latest 100 captured inputs, without opening market feeds or training models. --paper-trading records the original entry-and-hold experiment. --trading-advisor records position-aware buy/hold/sell advice and delayed simulated execution in a separate $100 account; these two collection flags may be combined. --paper-report and --advisor-report print their respective saved results without market requests, fitting, or starting collection.',
    );
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let client;
  let background;
  try {
    const configuration = getResearchDatabaseConfiguration();
    if (configuration.mode === 'local-database')
      await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
    client = createClient(configuration);
    const repository = createResearchRepository({ client, mode: configuration.mode });
    const paperTradingService =
      options.paperTrading || options.paperReport
        ? createPaperTradingService({ repository: createPaperTradingRepository({ client }) })
        : null;
    const tradingAdvisorService =
      options.tradingAdvisor || options.advisorReport
        ? createConfiguredTradingAdvisorService({
            repository: createTradingAdvisorRepository({ client }),
            trialRepository: createTradingPolicyTrialRepository({ client }),
            historyTrialRepository: createAdvisorHistoryTrialRepository({ client }),
          })
        : null;
    if (options.advisorReport) {
      console.log(JSON.stringify(await tradingAdvisorService.getReport(), null, 2));
      return;
    }
    if (options.paperReport) {
      console.log(JSON.stringify(await paperTradingService.getReport(), null, 2));
      return;
    }
    if (options.report) {
      const analysis = await getCollectorAnalysis({
        repository,
        now: Date.now(),
        replayLimit: 100,
      });
      console.log(JSON.stringify(analysis, null, 2));
      if (analysis.replay.failed) process.exitCode = 1;
      return;
    }
    background = createCollectorBackgroundTasks();
    await runResearchCollector({
      ...options,
      repository,
      learningService: createLearningService(repository),
      signal: controller.signal,
      analyzeResearch: () => background.run('analysis'),
      updateResearchModels: () => background.run('learning'),
      stopBackgroundTasks: () => background.close(),
      paperTradingService,
      patternResearchService: options.paperTrading
        ? createPatternResearchService({ repository: createPatternResearchRepository({ client }) })
        : null,
      tradingAdvisorService,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Collector stopped: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await background?.close();
    client?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
