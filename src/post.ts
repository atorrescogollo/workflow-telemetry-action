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
  labels.forEach((v, k) => {
    s += `${k}="${v}",`
  })
  return s.slice(0, -1)
}

export async function reportMetricsToPrometheusPushGateway(
  prometheusPushGatewayUrl: string,
  extraLabels: Map<string, string>,
  job: WorkflowJobType,
  stepsTelemetryData: stepTracer.TelemetryData[]
): Promise<void> {
  const jobStatus = core.getInput('job_status')
  const [jobStartTime, jobEndTime] = [
    new Date(stepsTelemetryData[0].startTime),
    new Date(stepsTelemetryData[stepsTelemetryData.length - 1].endTime)
  ]
  let promMetrics =
    `
# TYPE github_actions_job_start_time_seconds gauge
# HELP github_actions_job_start_time_seconds Start time of the job in seconds since epoch

# TYPE github_actions_job_end_time_seconds gauge
# HELP github_actions_job_end_time_seconds End time of the job in seconds since epoch

# TYPE github_actions_job_duration_seconds gauge
# HELP github_actions_job_duration_seconds Elapsed time for the job in seconds

# TYPE github_actions_job_conclusion gauge
# HELP github_actions_job_conclusion Conclusion of the job. 1 for success, 0 for failure

# TYPE github_actions_step_start_time_seconds gauge
# HELP github_actions_step_start_time_seconds Start time of the step in seconds since epoch

# TYPE github_actions_step_end_time_seconds gauge
# HELP github_actions_step_end_time_seconds End time of the step in seconds since epoch

# TYPE github_actions_step_duration_since_job_start_seconds gauge
# HELP github_actions_step_duration_since_job_start_seconds Elapsed time for the step in seconds since the job started

# TYPE github_actions_step_duration_seconds gauge
# HELP github_actions_step_duration_seconds Elapsed time for the step in seconds

# TYPE github_actions_step_conclusion gauge
# HELP github_actions_step_conclusion Conclusion of the step. 1 for success, 0 for failure
  `.trim() + '\n'

  const jobDuration = jobEndTime.getTime() - jobStartTime.getTime()

  const jobPromLabels = new Map([
    ['head_sha', job.head_sha],
    ['job_conclusion', jobStatus], // Can't use job.status or job.conclusion as they are not available yet since we are currently running in the job
    ...extraLabels
  ])
  promMetrics =
    `
${promMetrics}
github_actions_job_start_time_seconds{${prometheusLabels(jobPromLabels)}} ${jobStartTime.getTime() / 1000}
github_actions_job_end_time_seconds{${prometheusLabels(jobPromLabels)}} ${jobEndTime.getTime() / 1000}
github_actions_job_duration_seconds{${prometheusLabels(jobPromLabels)}} ${jobDuration / 1000}
github_actions_job_conclusion{${prometheusLabels(jobPromLabels)}} ${jobStatus === 'success' ? 1 : 0}
    `.trim() + '\n'

  for (const stepTelemetryData of stepsTelemetryData) {
    const stepName = stepTelemetryData.name
    const stepNameSafe = stepName.replace(/"/g, '\\"')
    const stepConclusion = stepTelemetryData.conclusion
    const stepStartTime = stepTelemetryData.startTime
    const stepEndTime = stepTelemetryData.endTime

    const stepPromlabels = new Map([
      ['step_name', stepNameSafe],
      ['step_conclusion', stepConclusion],
      ...jobPromLabels
    ])
    promMetrics = `
${promMetrics}
github_actions_step_start_time_seconds{${prometheusLabels(stepPromlabels)}} ${stepStartTime.getTime() / 1000}
github_actions_step_end_time_seconds{${prometheusLabels(stepPromlabels)}} ${stepEndTime.getTime() / 1000}
github_actions_step_duration_seconds{${prometheusLabels(stepPromlabels)}} ${(stepEndTime.getTime() - stepStartTime.getTime()) / 1000}
github_actions_step_duration_since_job_start_seconds{${prometheusLabels(stepPromlabels)}} ${(stepEndTime.getTime() - jobStartTime.getTime()) / 1000}
github_actions_step_conclusion{${prometheusLabels(stepPromlabels)}} ${stepConclusion === 'success' ? 1 : 0}
      `.trim()
  }

  logger.info(
    `Reporting metrics to Prometheus Push Gateway (prometheusPushGatewayUrl=${prometheusPushGatewayUrl})`
  )
  logger.info(
    `::group::Metrics\n` +
      `Metrics: \n\n---\n${promMetrics}\n---` +
      `\n::endgroup::`
  )
  try {
    const response = await fetch(prometheusPushGatewayUrl, {
      method: 'PUT',
      body: '\n' + promMetrics.trim() + '\n'
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
    const prometheusPushGatewayExtraLabels: Map<string, string> = new Map(
      Object.entries(
        JSON.parse(core.getInput('prometheus_push_gateway_extra_labels'))
      )
    )

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
