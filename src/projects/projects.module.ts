import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { ProjectRepository } from './project.repository.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectService } from './project.service.js';

@Module({ imports: [AuthModule], controllers: [ProjectsController], providers: [ProjectRepository, ProjectService, NoQueryGuard] })
export class ProjectsModule {}
