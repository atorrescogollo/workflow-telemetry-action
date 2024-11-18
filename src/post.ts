import * as core from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from '@octokit/action'
import * as stepTracer from './stepTracer'
import * as statCollector from './statCollector'
import * as processTracer from './processTracer'
import * as logger from './logger'
import { WorkflowJobType } from './interfaces'

const { pull_request } = github.context.payload
const { workflow, job, repo, runId, sha } = github.context
const PAGE_SIZE = 100
const octokit: Octokit = new Octokit()

async function getCurrentJob(): Promise<WorkflowJobType | null> {
  const _getCurrentJob = async (): Promise<WorkflowJobType | null> => {
    for (let page = 0; ; page++) {
      const result = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: repo.owner,
        repo: repo.repo,
        run_id: runId,
        per_page: PAGE_SIZE,
        page
      })
      const jobs: WorkflowJobType[] = result.data.jobs
      // If there are no jobs, stop here
      if (!jobs || !jobs.length) {
        break
      }
      const currentJobs = jobs.filter(
        it =>
          it.status === 'in_progress' &&
          it.runner_name === process.env.RUNNER_NAME
      )
      if (currentJobs && currentJobs.length) {
        return currentJobs[0]
      }
      // Since returning job count is less than page size, this means that there are no other jobs.
      // So no need to make another request for the next page.
      if (jobs.length < PAGE_SIZE) {
        break
      }
    }
    return null
  }
  try {
    for (let i = 0; i < 10; i++) {
      const currentJob: WorkflowJobType | null = await _getCurrentJob()
      if (currentJob && currentJob.id) {
        return currentJob
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch (error: any) {
    logger.error(
      `Unable to get current workflow job info. ` +
        `Please sure that your workflow have "actions:read" permission!`
    )
  }
  return null
}

async function reportAll(
  currentJob: WorkflowJobType,
  content: string
): Promise<void> {
  logger.info(`Reporting all content ...`)

  logger.debug(`Workflow - Job: ${workflow} - ${job}`)

  const jobUrl = `https://github.com/${repo.owner}/${repo.repo}/runs/${currentJob.id}?check_suite_focus=true`
  logger.debug(`Job url: ${jobUrl}`)

  const title = `## Workflow Telemetry - ${workflow} / ${currentJob.name}`
  logger.debug(`Title: ${title}`)

  const commit: string =
    (pull_request && pull_request.head && pull_request.head.sha) || sha
  logger.debug(`Commit: ${commit}`)

  const commitUrl = `https://github.com/${repo.owner}/${repo.repo}/commit/${commit}`
  logger.debug(`Commit url: ${commitUrl}`)

  const info =
    `Workflow telemetry for commit [${commit}](${commitUrl})\n` +
    `You can access workflow job details [here](${jobUrl})`

  const postContent: string = [title, info, content].join('\n')

  const jobSummary: string = core.getInput('job_summary')
  if ('true' === jobSummary) {
    core.summary.addRaw(postContent)
    await core.summary.write()
  }

  const commentOnPR: string = core.getInput('comment_on_pr')
  if (pull_request && 'true' === commentOnPR) {
    if (logger.isDebugEnabled()) {
      logger.debug(`Found Pull Request: ${JSON.stringify(pull_request)}`)
    }

    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: Number(github.context.payload.pull_request?.number),
      body: postContent
    })
  } else {
    logger.debug(`Couldn't find Pull Request`)
  }

  logger.info(`Reporting all content completed`)
}

function prometheusLabels(labels: Map<string, string>): string {
  let s = ``
  labels.forEach((value: string, key: string) => {
    s += `,${key}="${value.replace(/"/g, '\\"')}"`
  })
  return s.replace(/^,/, '')
}

export async function reportMetricsToPrometheusPushGateway(
  prometheusPushGatewayUrl: string,
  extraLabels: Map<string, string>,
  job: WorkflowJobType,
  stepsTelemetryData: stepTracer.TelemetryData[]
): Promise<void> {
  let promMetrics = `
  # TYPE github_actions_job_duration_ms gauge
  # HELP github_actions_job_duration_ms Elapsed time for the job in milliseconds

  # TYPE github_actions_job_conclusion gauge
  # HELP github_actions_job_conclusion Conclusion of the job. 1 for success, 0 for failure

  # TYPE github_actions_step_duration_ms gauge
  # HELP github_actions_step_duration_ms Elapsed time for the step in milliseconds

  # TYPE github_actions_step_conclusion gauge
  # HELP github_actions_step_conclusion Conclusion of the step. 1 for success, 0 for failure
  `

  let extraLabelsStr = ``
  extraLabels.forEach((value: string, key: string) => {
    extraLabelsStr += `,${key}="${value.replace(/"/g, '\\"')}"`
  })

  const jobDuration =
    new Date(job.completed_at ?? job.started_at).getTime() -
    new Date(job.started_at).getTime()

  let jobPromLabels = new Map<string, string>()
  jobPromLabels.set('head_sha', job.head_sha)
  jobPromLabels.set('job_status', job.status)
  jobPromLabels.set('job_conclusion', job.conclusion ?? 'unknown')
  jobPromLabels = new Map([...jobPromLabels, ...extraLabels])
  promMetrics = promMetrics.concat(
    `
    github_actions_job_duration_ms{${prometheusLabels(jobPromLabels)}} ${jobDuration}
    github_actions_job_conclusion{${prometheusLabels(jobPromLabels)}} ${job.conclusion === 'success' ? 1 : 0}
    `
  )

  for (const stepTelemetryData of stepsTelemetryData) {
    const stepName = stepTelemetryData.name
    const stepNameSafe = stepName.replace(/"/g, '\\"')
    const stepConclusion = stepTelemetryData.conclusion
    const stepStartTime = stepTelemetryData.startTime.getTime()
    const stepEndTime = stepTelemetryData.endTime.getTime()

    let stepPromlabels = new Map<string, string>()
    stepPromlabels.set('step_name', stepNameSafe)
    stepPromlabels.set('step_conclusion', stepConclusion)
    stepPromlabels = new Map([...stepPromlabels, ...jobPromLabels])
    promMetrics = promMetrics.concat(
      `
      github_actions_step_duration_ms{${prometheusLabels(stepPromlabels)}"} ${stepEndTime - Math.min(stepStartTime, stepEndTime)}
      github_actions_step_conclusion{${prometheusLabels(stepPromlabels)}"} ${stepConclusion === 'success' ? 1 : 0}
      `
    )
  }

  logger.info(
    `Reporting metrics to Prometheus Push Gateway (prometheusPushGatewayUrl=${prometheusPushGatewayUrl})`
  )
  try {
    const response = await fetch(prometheusPushGatewayUrl, {
      method: 'PUT',
      body: promMetrics
    })
    if (!response.ok) {
      throw new Error(
        `Failed to report metrics to Prometheus Push Gateway: ${response.status} - ${response.statusText}`
      )
    }
    logger.info(
      `Reported metrics to Prometheus Push Gateway: ${response.status} - ${response.statusText}`
    )
  } catch (error: any) {
    logger.error('Unable to report metrics to Prometheus Push Gateway')
    logger.error(error)
  }
}

async function run(): Promise<void> {
  try {
    const prometheusPushGatewayUrl = core.getInput(
      'prometheus_push_gateway_url'
    )
    const prometheusPushGatewayExtraLabels_Input = core.getInput(
      'prometheus_push_gateway_extra_labels'
    )
    let prometheusPushGatewayExtraLabels: Map<string, string> = new Map()
    if (prometheusPushGatewayExtraLabels_Input) {
      const d = JSON.parse(prometheusPushGatewayExtraLabels_Input)
      prometheusPushGatewayExtraLabels = new Map(Object.entries(d))
    }

    logger.info(`Finishing ...`)

    const currentJob: WorkflowJobType | null = await getCurrentJob()

    if (!currentJob) {
      logger.error(
        `Couldn't find current job. So action will not report any data.`
      )
      return
    }

    logger.debug(`Current job: ${JSON.stringify(currentJob)}`)

    // Finish step tracer
    await stepTracer.finish(currentJob)
    // Finish stat collector
    await statCollector.finish(currentJob)
    // Finish process tracer
    await processTracer.finish(currentJob)

    // Report step tracer
    const stepTracerTelemetry = await stepTracer.report(currentJob)

    let stepTracerContent: string | null = null
    if (prometheusPushGatewayUrl !== '' && stepTracerTelemetry !== null) {
      if (!prometheusPushGatewayUrl.includes('/job/')) {
        logger.error(
          `Prometheus Push Gateway URL must contain the job name. ` +
            `Please provide the URL in the format: ` +
            `http(s)://<host>(:<port>)/metrics/job/<job-name>/<labelname1>/<labelvalue1>/...'`
        )
        logger.error('Skipping reporting metrics to Prometheus Push Gateway')
      } else {
        reportMetricsToPrometheusPushGateway(
          prometheusPushGatewayUrl,
          prometheusPushGatewayExtraLabels,
          currentJob,
          stepTracerTelemetry
        )
        stepTracerContent = stepTracer.generateTraceChartFromTelemetryData(
          currentJob.name,
          stepTracerTelemetry
        )
      }
    }

    // Report stat collector
    const stepCollectorContent: string | null =
      await statCollector.report(currentJob)
    // Report process tracer
    const procTracerContent: string | null =
      await processTracer.report(currentJob)

    let allContent = ''

    if (stepTracerContent) {
      allContent = allContent.concat(stepTracerContent, '\n')
    }
    if (stepCollectorContent) {
      allContent = allContent.concat(stepCollectorContent, '\n')
    }
    if (procTracerContent) {
      allContent = allContent.concat(procTracerContent, '\n')
    }

    await reportAll(currentJob, allContent)

    logger.info(`Finish completed`)
  } catch (error: any) {
    logger.error(error.message)
  }
}

run()
