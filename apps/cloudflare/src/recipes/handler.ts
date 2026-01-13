/**
 * Recipe & Workflow Handlers
 *
 * Manages declarative workflow definitions and their executions.
 * Recipes define *what should happen*; sandboxes execute.
 */

import type { Env, Recipe, RecipeStep, Execution, Artifact } from '../types';
import { SandboxClient } from '../sandbox/client';

function generateId(): string {
  return crypto.randomUUID();
}

// Check if user has access to a dashboard
async function checkDashboardAccess(
  env: Env,
  dashboardId: string,
  userId: string,
  requiredRole?: 'owner' | 'editor' | 'viewer'
): Promise<{ hasAccess: boolean; role?: string }> {
  const member = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!member) {
    return { hasAccess: false };
  }

  // Check role permissions in JavaScript for better mock compatibility
  const roleHierarchy: Record<string, number> = { owner: 3, editor: 2, viewer: 1 };
  const userRoleLevel = roleHierarchy[member.role] || 0;
  const requiredLevel = requiredRole ? roleHierarchy[requiredRole] : 0;

  return {
    hasAccess: userRoleLevel >= requiredLevel,
    role: member.role,
  };
}

// Check if user has access to a recipe (via its dashboard)
async function checkRecipeAccess(
  env: Env,
  recipeId: string,
  userId: string,
  requiredRole?: 'owner' | 'editor' | 'viewer'
): Promise<{ hasAccess: boolean; recipe?: Record<string, unknown> }> {
  const recipe = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();

  if (!recipe) {
    return { hasAccess: false };
  }

  // Recipes without dashboard_id are accessible to any authenticated user
  if (!recipe.dashboard_id) {
    return { hasAccess: true, recipe };
  }

  const { hasAccess } = await checkDashboardAccess(env, recipe.dashboard_id as string, userId, requiredRole);
  return { hasAccess, recipe: hasAccess ? recipe : undefined };
}

// Check if user has access to an execution (via execution → recipe → dashboard)
async function checkExecutionAccess(
  env: Env,
  executionId: string,
  userId: string,
  requiredRole?: 'owner' | 'editor' | 'viewer'
): Promise<{ hasAccess: boolean; execution?: Record<string, unknown> }> {
  const execution = await env.DB.prepare(`
    SELECT * FROM executions WHERE id = ?
  `).bind(executionId).first();

  if (!execution) {
    return { hasAccess: false };
  }

  const { hasAccess } = await checkRecipeAccess(env, execution.recipe_id as string, userId, requiredRole);
  return { hasAccess, execution: hasAccess ? execution : undefined };
}

// List recipes (only those the user has access to)
export async function listRecipes(
  env: Env,
  userId: string,
  dashboardId?: string
): Promise<Response> {
  // If dashboardId specified, verify access first
  if (dashboardId) {
    const { hasAccess } = await checkDashboardAccess(env, dashboardId, userId, 'viewer');
    if (!hasAccess) {
      return Response.json({ error: 'Dashboard not found or no access' }, { status: 404 });
    }
  }

  // Get recipes: either for specific dashboard, or all dashboards user has access to + global recipes
  let result;
  if (dashboardId) {
    result = await env.DB.prepare(`
      SELECT * FROM recipes WHERE dashboard_id = ? ORDER BY updated_at DESC
    `).bind(dashboardId).all();
  } else {
    // Get recipes from dashboards user is a member of, plus global recipes (no dashboard_id)
    result = await env.DB.prepare(`
      SELECT r.* FROM recipes r
      LEFT JOIN dashboard_members dm ON r.dashboard_id = dm.dashboard_id
      WHERE r.dashboard_id IS NULL OR dm.user_id = ?
      ORDER BY r.updated_at DESC
    `).bind(userId).all();
  }

  const recipes = result.results.map(r => ({
    id: r.id,
    dashboardId: r.dashboard_id,
    name: r.name,
    description: r.description,
    steps: JSON.parse(r.steps as string),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return Response.json({ recipes });
}

// Get a single recipe
export async function getRecipe(
  env: Env,
  recipeId: string,
  userId: string
): Promise<Response> {
  const { hasAccess, recipe } = await checkRecipeAccess(env, recipeId, userId, 'viewer');

  if (!hasAccess || !recipe) {
    return Response.json({ error: 'Recipe not found or no access' }, { status: 404 });
  }

  return Response.json({
    recipe: {
      id: recipe.id,
      dashboardId: recipe.dashboard_id,
      name: recipe.name,
      description: recipe.description,
      steps: JSON.parse(recipe.steps as string),
      createdAt: recipe.created_at,
      updatedAt: recipe.updated_at,
    }
  });
}

// Create a recipe
export async function createRecipe(
  env: Env,
  userId: string,
  data: {
    dashboardId?: string;
    name: string;
    description?: string;
    steps?: RecipeStep[];
  }
): Promise<Response> {
  // If dashboardId specified, verify user has editor access
  if (data.dashboardId) {
    const { hasAccess } = await checkDashboardAccess(env, data.dashboardId, userId, 'editor');
    if (!hasAccess) {
      return Response.json({ error: 'Dashboard not found or no access' }, { status: 404 });
    }
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO recipes (id, dashboard_id, name, description, steps, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.dashboardId || null,
    data.name,
    data.description || '',
    JSON.stringify(data.steps || []),
    now,
    now
  ).run();

  const recipe: Recipe = {
    id,
    dashboardId: data.dashboardId || '',
    name: data.name,
    description: data.description || '',
    steps: data.steps || [],
    createdAt: now,
    updatedAt: now,
  };

  return Response.json({ recipe }, { status: 201 });
}

// Update a recipe
export async function updateRecipe(
  env: Env,
  recipeId: string,
  userId: string,
  data: {
    name?: string;
    description?: string;
    steps?: RecipeStep[];
  }
): Promise<Response> {
  const { hasAccess, recipe: existing } = await checkRecipeAccess(env, recipeId, userId, 'editor');

  if (!hasAccess || !existing) {
    return Response.json({ error: 'Recipe not found or no access' }, { status: 404 });
  }

  const now = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE recipes SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      steps = COALESCE(?, steps),
      updated_at = ?
    WHERE id = ?
  `).bind(
    data.name || null,
    data.description || null,
    data.steps ? JSON.stringify(data.steps) : null,
    now,
    recipeId
  ).run();

  const updated = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();

  return Response.json({
    recipe: {
      id: updated!.id,
      dashboardId: updated!.dashboard_id,
      name: updated!.name,
      description: updated!.description,
      steps: JSON.parse(updated!.steps as string),
      createdAt: updated!.created_at,
      updatedAt: updated!.updated_at,
    }
  });
}

// Delete a recipe
export async function deleteRecipe(
  env: Env,
  recipeId: string,
  userId: string
): Promise<Response> {
  // Only owners can delete recipes
  const { hasAccess } = await checkRecipeAccess(env, recipeId, userId, 'owner');

  if (!hasAccess) {
    return Response.json({ error: 'Recipe not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`DELETE FROM recipes WHERE id = ?`).bind(recipeId).run();
  return new Response(null, { status: 204 });
}

// Start an execution of a recipe
export async function startExecution(
  env: Env,
  recipeId: string,
  userId: string,
  context?: Record<string, unknown>
): Promise<Response> {
  const { hasAccess, recipe } = await checkRecipeAccess(env, recipeId, userId, 'editor');

  if (!hasAccess || !recipe) {
    return Response.json({ error: 'Recipe not found or no access' }, { status: 404 });
  }

  return createExecution(env, recipeId, recipe, context);
}

// Internal version for system-triggered executions (cron/events)
// Access was already validated when the schedule was created
export async function startExecutionInternal(
  env: Env,
  recipeId: string,
  context?: Record<string, unknown>
): Promise<Response> {
  const recipe = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();

  if (!recipe) {
    return Response.json({ error: 'Recipe not found' }, { status: 404 });
  }

  return createExecution(env, recipeId, recipe, context);
}

// Shared execution creation logic
async function createExecution(
  env: Env,
  recipeId: string,
  recipe: Record<string, unknown>,
  context?: Record<string, unknown>
): Promise<Response> {
  const steps = JSON.parse(recipe.steps as string) as RecipeStep[];
  const firstStepId = steps.length > 0 ? steps[0].id : null;

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO executions (id, recipe_id, status, current_step_id, context, started_at)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).bind(
    id,
    recipeId,
    firstStepId,
    JSON.stringify(context || {}),
    now
  ).run();

  const execution: Execution = {
    id,
    recipeId,
    status: 'running',
    currentStepId: firstStepId,
    context: context || {},
    startedAt: now,
    completedAt: null,
    error: null,
  };

  // If there's a first step, execute it asynchronously
  // In production, this would be handled by a durable orchestrator
  if (firstStepId) {
    // For now, we just mark it as running
    // The actual execution would be triggered via a separate mechanism
  }

  return Response.json({ execution }, { status: 201 });
}

// Get execution status
export async function getExecution(
  env: Env,
  executionId: string,
  userId: string
): Promise<Response> {
  const { hasAccess, execution } = await checkExecutionAccess(env, executionId, userId, 'viewer');

  if (!hasAccess || !execution) {
    return Response.json({ error: 'Execution not found or no access' }, { status: 404 });
  }

  // Get artifacts
  const artifacts = await env.DB.prepare(`
    SELECT * FROM artifacts WHERE execution_id = ?
  `).bind(executionId).all();

  return Response.json({
    execution: {
      id: execution.id,
      recipeId: execution.recipe_id,
      status: execution.status,
      currentStepId: execution.current_step_id,
      context: JSON.parse(execution.context as string),
      startedAt: execution.started_at,
      completedAt: execution.completed_at,
      error: execution.error,
    },
    artifacts: artifacts.results.map(a => ({
      id: a.id,
      executionId: a.execution_id,
      stepId: a.step_id,
      type: a.type,
      name: a.name,
      content: a.content,
      createdAt: a.created_at,
    })),
  });
}

// List executions for a recipe
export async function listExecutions(
  env: Env,
  recipeId: string,
  userId: string
): Promise<Response> {
  // Verify user has access to the recipe
  const { hasAccess } = await checkRecipeAccess(env, recipeId, userId, 'viewer');

  if (!hasAccess) {
    return Response.json({ error: 'Recipe not found or no access' }, { status: 404 });
  }

  const result = await env.DB.prepare(`
    SELECT * FROM executions WHERE recipe_id = ? ORDER BY started_at DESC
  `).bind(recipeId).all();

  const executions = result.results.map(e => ({
    id: e.id,
    recipeId: e.recipe_id,
    status: e.status,
    currentStepId: e.current_step_id,
    context: JSON.parse(e.context as string),
    startedAt: e.started_at,
    completedAt: e.completed_at,
    error: e.error,
  }));

  return Response.json({ executions });
}

// Pause an execution
export async function pauseExecution(
  env: Env,
  executionId: string,
  userId: string
): Promise<Response> {
  const { hasAccess, execution } = await checkExecutionAccess(env, executionId, userId, 'editor');

  if (!hasAccess || !execution) {
    return Response.json({ error: 'Execution not found or no access' }, { status: 404 });
  }

  if (execution.status !== 'running') {
    return Response.json({ error: 'Execution is not running' }, { status: 400 });
  }

  await env.DB.prepare(`
    UPDATE executions SET status = ? WHERE id = ?
  `).bind('paused', executionId).run();

  return Response.json({ status: 'paused' });
}

// Resume an execution
export async function resumeExecution(
  env: Env,
  executionId: string,
  userId: string
): Promise<Response> {
  const { hasAccess, execution } = await checkExecutionAccess(env, executionId, userId, 'editor');

  if (!hasAccess || !execution) {
    return Response.json({ error: 'Execution not found or no access' }, { status: 404 });
  }

  if (execution.status !== 'paused') {
    return Response.json({ error: 'Execution is not paused' }, { status: 400 });
  }

  await env.DB.prepare(`
    UPDATE executions SET status = ? WHERE id = ?
  `).bind('running', executionId).run();

  return Response.json({ status: 'running' });
}

// Complete an execution (called by orchestrator)
export async function completeExecution(
  env: Env,
  executionId: string,
  error?: string
): Promise<Response> {
  const now = new Date().toISOString();
  const status = error ? 'failed' : 'completed';

  await env.DB.prepare(`
    UPDATE executions SET status = ?, completed_at = ?, error = ? WHERE id = ?
  `).bind(status, now, error || null, executionId).run();

  return Response.json({ status });
}

// Add artifact to execution
export async function addArtifact(
  env: Env,
  executionId: string,
  data: {
    stepId: string;
    type: 'file' | 'log' | 'summary' | 'output';
    name: string;
    content: string;
  }
): Promise<Response> {
  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO artifacts (id, execution_id, step_id, type, name, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, executionId, data.stepId, data.type, data.name, data.content, now).run();

  const artifact: Artifact = {
    id,
    executionId,
    stepId: data.stepId,
    type: data.type,
    name: data.name,
    content: data.content,
    createdAt: now,
  };

  return Response.json({ artifact }, { status: 201 });
}

// Execute a single step (orchestrator internal)
export async function executeStep(
  env: Env,
  executionId: string,
  step: RecipeStep,
  context: Record<string, unknown>
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  switch (step.type) {
    case 'run_agent': {
      // This would create a sandbox session and run the agent
      // For now, just simulate
      return { success: true, output: { message: 'Agent step simulated' } };
    }

    case 'wait': {
      const duration = (step.config.durationMs as number) || 1000;
      await new Promise(resolve => setTimeout(resolve, Math.min(duration, 10000)));
      return { success: true };
    }

    case 'branch': {
      const condition = step.config.condition as string;
      // Evaluate condition against context
      // For now, just return true
      return { success: true, output: { branch: 'true' } };
    }

    case 'notify': {
      const message = step.config.message as string;
      // Would send notification
      return { success: true, output: { notified: true, message } };
    }

    case 'human_approval': {
      // Would wait for human approval
      // For now, auto-approve
      return { success: true, output: { approved: true } };
    }

    default:
      return { success: false, error: `Unknown step type: ${step.type}` };
  }
}
