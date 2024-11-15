import { WorkflowJobStepsType, WorkflowJobType } from './interfaces'
import * as logger from './logger'
import * as fs from 'fs'

export type TelemetryData = {
  number: number
  name: string
  conclusion: string
  startTime: Date
  endTime: Date
}

function generateTelemetryDataForSteps(job: WorkflowJobType): TelemetryData[] {
  let telemetryData: TelemetryData[] = []

  let backgroundSteps: WorkflowJobStepsType = []
  for (const step of job.steps || []) {
    if (step.name.trim().toLowerCase().endsWith('(background)')) {
      backgroundSteps.push(step)
      continue
    }
    let stepName = step.name
    let started_at = step.started_at
    let completed_at = step.completed_at

    logger.info(`Step: ${stepName} - ${step.conclusion}`)
    if (step.conclusion === 'skipped') {
      continue
    }
    let backgroundStepNameMatch =
      /^Attach "(.*)" and wait for completion$/.exec(stepName)
    if (backgroundStepNameMatch) {
      stepName = backgroundStepNameMatch?.[1]
      logger.debug(`Found background step: ${stepName}`)
      const startingStep = backgroundSteps.find(
        backgroundStep => backgroundStep.name === `${stepName} (background)`
      )
      if (startingStep) {
        started_at = startingStep.started_at
        try {
          started_at = fs.readFileSync(`/tmp/${stepName}.started_at`, 'utf8')
        } catch (error) {
          logger.info(
            `Unable to read "/tmp/${stepName}.started_at". Leaving started_at as when the step started in the background: ${error}`
          )
        }
      } else {
        logger.info(
          `Unable to find starting step for background step: ${stepName}. Leaving started_at as when the attach step finished`
        )
        started_at = step.completed_at
      }

      try {
        completed_at = fs.readFileSync(`/tmp/${stepName}.completed_at`, 'utf8')
      } catch (error) {
        logger.info(
          `Unable to read "/tmp/${stepName}.completed_at". Leaving completed_at as it finished when attached: ${error}`
        )
      }
    }

    if (!started_at || !completed_at) {
      continue
    }

    telemetryData.push({
      number: step.number,
      name: stepName,
      conclusion: step.conclusion ?? 'unknown',
      startTime: new Date(started_at),
      endTime: new Date(completed_at)
    })
  }

  return telemetryData
}

export function generateTraceChartFromTelemetryData(
  jobName: string,
  stepsTelemetryData: TelemetryData[]
): string {
  let chartContent = ''

  /**
     gantt
       title Build
       dateFormat x
       axisFormat %H:%M:%S
       Set up job : milestone, 1658073446000, 1658073450000
       Collect Workflow Telemetry : 1658073450000, 1658073450000
       Run actions/checkout@v2 : 1658073451000, 1658073453000
       Set up JDK 8 : 1658073453000, 1658073458000
       Build with Maven : 1658073459000, 1658073654000
       Run invalid command : crit, 1658073655000, 1658073654000
       Archive test results : done, 1658073655000, 1658073654000
       Post Set up JDK 8 : 1658073655000, 1658073654000
       Post Run actions/checkout@v2 : 1658073655000, 1658073655000
  */

  chartContent = chartContent.concat('gantt', '\n')
  chartContent = chartContent.concat('\t', `title ${jobName}`, '\n')
  chartContent = chartContent.concat('\t', `dateFormat x`, '\n')
  chartContent = chartContent.concat('\t', `axisFormat %H:%M:%S`, '\n')

  for (const stepTelemetryData of stepsTelemetryData) {
    const stepNumber = stepTelemetryData.number
    const stepName = stepTelemetryData.name
    const stepConclusion = stepTelemetryData.conclusion
    const stepStartTime = stepTelemetryData.startTime.getTime()
    const stepEndTime = stepTelemetryData.endTime.getTime()

    chartContent = chartContent.concat(
      '\t',
      `${stepName.replace(/:/g, '-')} : `
    )

    if (stepName === 'Set up job' && stepNumber === 1) {
      chartContent = chartContent.concat('milestone, ')
    }

    if (stepConclusion === 'failure') {
      // to show red
      chartContent = chartContent.concat('crit, ')
    } else if (stepConclusion === 'skipped') {
      // to show grey
      chartContent = chartContent.concat('done, ')
    }

    chartContent = chartContent.concat(`${stepStartTime}, ${stepEndTime}`, '\n')
  }

  const postContentItems: string[] = [
    '',
    '### Step Trace',
    '',
    '```mermaid' + '\n' + chartContent + '\n' + '```'
  ]
  return postContentItems.join('\n')
}

///////////////////////////

export async function start(): Promise<boolean> {
  logger.info(`Starting step tracer ...`)

  try {
    logger.info(`Started step tracer`)

    return true
  } catch (error: any) {
    logger.error('Unable to start step tracer')
    logger.error(error)

    return false
  }
}

export async function finish(currentJob: WorkflowJobType): Promise<boolean> {
  logger.info(`Finishing step tracer ...`)

  try {
    logger.info(`Finished step tracer`)

    return true
  } catch (error: any) {
    logger.error('Unable to finish step tracer')
    logger.error(error)

    return false
  }
}

export async function report(
  currentJob: WorkflowJobType
): Promise<TelemetryData[] | null> {
  logger.info(`Reporting step tracer result ...`)

  if (!currentJob) {
    return null
  }

  try {
    const telemetryData = generateTelemetryDataForSteps(currentJob)

    logger.info(`Reported step tracer result`)

    return telemetryData
  } catch (error: any) {
    logger.error('Unable to report step tracer result')
    logger.error(error)

    return null
  }
}
