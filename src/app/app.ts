import { Component } from '@angular/core';
import { Diagram } from './diagram/diagram';

@Component({
  imports: [Diagram],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {}
