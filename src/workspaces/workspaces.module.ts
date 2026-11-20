import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspaceRepository } from './workspace.repository.js';
import { WorkspaceService } from './workspace.service.js';

@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController],
  providers: [WorkspaceRepository, WorkspaceService, NoQueryGuard],
})
export class WorkspacesModule {}
